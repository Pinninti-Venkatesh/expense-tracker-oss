import express from 'express';
import logger from '../utils/logger.js';
import * as store from '../drive/store.js';
import { poll, newExpenseId } from '../poll.js';
import { checkStatementsAutomatically } from '../upi/statement.js';
import { enrichAll, computeEnrichment, applyEnrichment } from '../enrich.js';
import { recordCorrection, applyRules, applyToMatching } from '../learning/corrections.js';
import { CATEGORIES } from '../llm/extract.js';
import { allCategories, canonicalCategory, addCategory, removeCategory, canonicalPaymentType } from '../categories.js';
import { isMailReady } from '../auth/mail-access.js';
import { requireContextUser } from '../context.js';
import { withoutReview } from '../llm/review.js';
import { validate as validateRefund, buildRefund, refundedTotal } from '../refunds.js';
import { today, localDate, startOfPreviousMonth } from '../utils/datetime.js';

const router = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Drops the "needs a look" question from the given spends, in place. */
function clearReview(db, ids) {
  const wanted = new Set(ids);
  db.expenses.forEach((e, i) => {
    if (wanted.has(e.id) && (e.needsReview || e.categoryOptions)) db.expenses[i] = withoutReview(e);
  });
}

// Every route here runs inside the signed-in account's context (auth/session.js),
// so each store and Gmail call below reaches only that account's data.

// --- expenses ------------------------------------------------------------

router.get('/expenses', asyncRoute(async (req, res) => {
  const db = await store.init();
  const expenses = [...db.expenses].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  res.json({ expenses, categories: allCategories(db) });
}));

router.post('/expenses', asyncRoute(async (req, res) => {
  const { merchant, amount, date, category, bank, paymentType, note } = req.body || {};

  if (!merchant || typeof merchant !== 'string') {
    return res.status(400).json({ error: 'merchant is required' });
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const db = await store.init();

  // Manual entries get the benefit of learned rules too.
  const ruled = applyRules(
    { merchant: merchant.trim(), category: category || 'General' },
    db.categoryRules,
  );

  const expense = {
    id: newExpenseId(),
    merchant: ruled.merchant,
    amount: numericAmount,
    date: date || today(),
    category: canonicalCategory(db, ruled.category) || 'General',
    categorySource: ruled.categorySource || 'manual',
    bank: bank || null,
    paymentType: canonicalPaymentType(paymentType),
    note: note || null,
    source: 'manual',
    isExpense: true,
    createdAt: new Date().toISOString(),
  };

  await store.mutate((d) => d.expenses.push(expense));
  res.status(201).json(expense);
}));

router.delete('/expenses/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  let removed = false;

  await store.mutate((d) => {
    const i = d.expenses.findIndex((e) => e.id === id);
    if (i !== -1) {
      d.expenses.splice(i, 1);
      removed = true;
    }
  });

  if (!removed) return res.status(404).json({ error: 'No such expense' });
  res.json({ ok: true });
}));

// --- refunds --------------------------------------------------------------

router.post('/expenses/:id/refunds', asyncRoute(async (req, res) => {
  const db = await store.init();
  const expense = db.expenses.find((e) => e.id === req.params.id);
  if (!expense) return res.status(404).json({ error: 'No such expense' });

  // Validates against what's already been refunded, so partial refunds can
  // accumulate but never exceed the original charge.
  const amount = validateRefund(expense, req.body?.amount);
  const refund = buildRefund({ amount, date: req.body?.date, note: req.body?.note });

  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === req.params.id);
    target.refunds ||= [];
    target.refunds.push(refund);
  });

  res.status(201).json({ refund, refunded: refundedTotal({ refunds: [...(expense.refunds || []), refund] }) });
}));

router.delete('/expenses/:id/refunds/:refundId', asyncRoute(async (req, res) => {
  let removed = false;

  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === req.params.id);
    if (!target?.refunds) return;
    const i = target.refunds.findIndex((r) => r.id === req.params.refundId);
    if (i !== -1) { target.refunds.splice(i, 1); removed = true; }
  });

  if (!removed) return res.status(404).json({ error: 'No such refund' });
  res.json({ ok: true });
}));

// --- the learning loop ---------------------------------------------------

router.post('/expenses/:id/flag', asyncRoute(async (req, res) => {
  const { reason, corrected } = req.body || {};

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'reason is required — it is what the system learns from' });
  }
  if (!corrected || typeof corrected !== 'object' || !Object.keys(corrected).length) {
    return res.status(400).json({ error: 'corrected must contain at least one field to change' });
  }
  if ('category' in corrected) {
    const db = await store.init();
    const canonical = canonicalCategory(db, corrected.category);
    if (!canonical) {
      return res.status(400).json({ error: `Unknown category: ${corrected.category}` });
    }
    corrected.category = canonical; // store the canonical casing
  }
  if ('amount' in corrected) {
    const n = Number(corrected.amount);
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    corrected.amount = n;
  }

  const applyToAll = Boolean(req.body?.applyToAll);

  let outcome;
  let alsoUpdated = [];
  try {
    await store.mutate((d) => {
      // Captured before the correction lands, since it may rename the merchant.
      const originalMerchant = d.expenses.find((e) => e.id === req.params.id)?.merchant;

      outcome = recordCorrection(d, { expenseId: req.params.id, reason: reason.trim(), corrected });
      clearReview(d, [req.params.id]);

      if (applyToAll) {
        alsoUpdated = applyToMatching(d, {
          merchant: originalMerchant,
          corrected,
          excludeId: req.params.id,
          at: outcome.correction.at,
        });
      }
    });
  } catch (err) {
    if (err.message.startsWith('No expense with id')) return res.status(404).json({ error: err.message });
    throw err;
  }

  logger.info(
    outcome.learnedRule
      ? `Learned rule: ${outcome.learnedRule.merchant} -> ${outcome.learnedRule.category}`
      : 'Recorded correction as a prompt example',
  );

  if (alsoUpdated.length) logger.info(`Applied the same correction to ${alsoUpdated.length} past transaction(s)`);

  const base = outcome.learnedRule
    ? 'A permanent rule was created — this merchant will always use that category.'
    : 'Recorded as an example the extractor will see on future emails.';

  res.json({
    ok: true,
    learnedRule: outcome.learnedRule,
    alsoUpdated: alsoUpdated.length,
    // Tells the UI which of the two mechanisms fired, so it can say so plainly.
    learning: alsoUpdated.length
      ? `${alsoUpdated.length} past transaction${alsoUpdated.length === 1 ? '' : 's'} updated too. ${base}`
      : base,
  });
}));

// --- enrichment: what was actually bought ------------------------------

/**
 * Manually add or edit a transaction's details — the same `description`/`items`
 * fields that "Look up details" fills in, but by hand and for any source, not
 * just bank-email transactions. Writing them marks the row enriched so the UI
 * shows them exactly like looked-up details; clearing both removes them.
 */
router.patch('/expenses/:id/details', asyncRoute(async (req, res) => {
  const db = await store.init();
  const expense = db.expenses.find((e) => e.id === req.params.id);
  if (!expense) return res.status(404).json({ error: 'No such expense' });

  const description = req.body?.description == null ? null : String(req.body.description).trim().slice(0, 500);
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = rawItems.map((i) => String(i).trim()).filter(Boolean).slice(0, 50);
  const hasContent = Boolean(description) || items.length > 0;

  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === req.params.id);
    target.description = description || null;
    target.items = items;
    target.detailsSource = 'manual';
    target.enrichedAt = new Date().toISOString();
    // Content present -> show it like a successful lookup; cleared -> back to
    // the "nothing here" state rather than a stale lookup status.
    target.enrichStatus = hasContent ? 'ok' : 'manual_cleared';
  });

  res.json({ ok: true, description: description || null, items });
}));

/** Look up one expense's order email on demand (used by the detail view). */
router.post('/expenses/:id/enrich', asyncRoute(async (req, res) => {
  const db = await store.init();
  const expense = db.expenses.find((e) => e.id === req.params.id);
  if (!expense) return res.status(404).json({ error: 'No such expense' });

  const patch = await computeEnrichment(expense);
  await applyEnrichment(expense.id, patch);
  res.json({ ok: true, ...patch });
}));

/** Enrich everything not yet looked at. Long-running: runs in the background
 *  and lands in the UI on its next refetch. */
router.post('/enrich', asyncRoute(async (req, res) => {
  if (!isMailReady()) return res.status(401).json({ error: 'Not authenticated', loginUrl: '/api/login?intent=reconnect' });
  const force = req.body?.force === true;

  enrichAll({ force })
    .then((result) => {
      logger.info('enrich finished', result);
    })
    .catch((err) => {
      logger.error('enrich failed', err.message);
    });

  res.status(202).json({ started: true, force });
}));

router.get('/learning', asyncRoute(async (req, res) => {
  const db = await store.init();
  res.json({
    rules: db.categoryRules,
    corrections: [...db.corrections].reverse().slice(0, 50),
  });
}));

// --- sync & live updates -------------------------------------------------

// A server that was away reads its backlog in batches: `remaining` says how many
// are left, and the app asks again until it's zero.
router.post('/sync', asyncRoute(async (req, res) => {
  const result = await poll();
  // With a statement password kept (UPI_STATEMENT_PASSWORD), new statements too.
  const statements = result.skipped ? null : await checkStatementsAutomatically();
  res.json({ ...result, ...(statements && { statementsAdded: statements.added || 0 }) });
}));

/**
 * The first sync: every bank alert since the 1st of last month, so a new
 * account opens on real numbers instead of an empty list.
 *
 * It works in short batches the app repeats until `done`, never as one long
 * background job — Cloud Run only guarantees CPU while a request is open, so
 * work left running after the response can stall. Each batch is idempotent
 * (processed emails are skipped), so an interrupted first sync simply resumes
 * the next time the app is opened.
 */
const FIRST_SYNC_BATCH = 12;

// Emails that failed during this account's first sync. Excluded from later
// batches so one bad email can't be retried forever; the routine poll still
// retries anything recent.
const firstSyncFailures = new Map();

router.post('/sync/first', asyncRoute(async (req, res) => {
  if (!isMailReady()) return res.status(401).json({ error: 'Not authenticated', loginUrl: '/api/login?intent=reconnect' });

  const { id: accountId } = requireContextUser();
  // Midnight on the 1st of last month in the user's timezone, not the server's.
  const since = startOfPreviousMonth();
  const sinceLabel = localDate(since);

  const failed = firstSyncFailures.get(accountId) || new Set();
  firstSyncFailures.set(accountId, failed);

  const startedAt = Date.now();
  const result = await poll({
    afterEpoch: Math.floor(since / 1000),
    label: 'first sync',
    limit: FIRST_SYNC_BATCH,
    exclude: failed,
  });
  (result.failedIds || []).forEach((id) => failed.add(id));

  const summary = {
    since: sinceLabel,
    added: result.added || 0,
    scanned: result.scanned || 0,
    remaining: result.remaining || 0,
    failed: failed.size,
  };

  if (result.skipped === 'already_running') return res.json({ ...summary, busy: true, done: false });
  if (result.skipped) return res.json({ ...summary, done: false, error: 'Google access is not ready. Reconnect and try again.' });
  if (result.error || result.abortedReason) {
    return res.json({ ...summary, done: false, error: result.abortedReason || result.error });
  }

  const done = summary.remaining === 0;
  if (done) {
    await store.mutate((d) => {
      d.meta ||= {};
      d.meta.firstSyncAt = new Date().toISOString();
      // Everything up to now is read: routine polls start from here.
      d.meta.lastPollAt = new Date(startedAt).toISOString();
    });
    firstSyncFailures.delete(accountId);
    const statements = await checkStatementsAutomatically();
    if (statements) summary.statementsAdded = statements.added || 0;
  }
  res.json({ ...summary, done });
}));

/** Marks a "needs a look" spend as answered without changing its category. */
router.post('/expenses/:id/reviewed', asyncRoute(async (req, res) => {
  let found = false;
  await store.mutate((d) => {
    const i = d.expenses.findIndex((e) => e.id === req.params.id);
    if (i === -1) return;
    found = true;
    d.expenses[i] = withoutReview(d.expenses[i]);
  });
  if (!found) return res.status(404).json({ error: 'No such expense' });
  res.json({ ok: true });
}));

// --- categories -----------------------------------------------------------

router.get('/categories', asyncRoute(async (req, res) => {
  const db = await store.init();
  res.json({ categories: allCategories(db), custom: db.customCategories || [] });
}));

router.post('/categories', asyncRoute(async (req, res) => {
  let created;
  try {
    await store.mutate((d) => { created = addCategory(d, req.body?.name); });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  const db = await store.init();
  res.status(201).json({ ok: true, category: created, categories: allCategories(db) });
}));

router.delete('/categories/:name', asyncRoute(async (req, res) => {
  let result;
  try {
    await store.mutate((d) => { result = removeCategory(d, req.params.name, req.body?.reassignTo); });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  const db = await store.init();
  res.json({ ok: true, ...result, categories: allCategories(db) });
}));

// Frictionless category change: set a transaction's category and remember it as
// a merchant rule, no mandatory reason. `applyToAll` also fixes past charges
// from the same merchant. This is the light path; /flag stays for richer fixes.
router.post('/expenses/:id/category', asyncRoute(async (req, res) => {
  const db = await store.init();
  const canonical = canonicalCategory(db, req.body?.category);
  if (!canonical) return res.status(400).json({ error: `Unknown category: ${req.body?.category}` });

  const applyToAll = Boolean(req.body?.applyToAll);
  let outcome;
  let alsoUpdated = [];
  try {
    await store.mutate((d) => {
      const originalMerchant = d.expenses.find((e) => e.id === req.params.id)?.merchant;
      outcome = recordCorrection(d, {
        expenseId: req.params.id,
        reason: null, // category-only change becomes a deterministic rule, not a few-shot example
        corrected: { category: canonical },
      });
      if (applyToAll) {
        alsoUpdated = applyToMatching(d, {
          merchant: originalMerchant,
          corrected: { category: canonical },
          excludeId: req.params.id,
          at: outcome.correction.at,
        });
      }
      // Choosing a category answers "needs a look", here and on every spend
      // the choice was copied to.
      clearReview(d, [req.params.id, ...alsoUpdated]);
    });
  } catch (err) {
    if (err.message.startsWith('No expense with id')) return res.status(404).json({ error: err.message });
    throw err;
  }

  res.json({ ok: true, category: canonical, learnedRule: outcome.learnedRule, alsoUpdated: alsoUpdated.length });
}));

export default router;
