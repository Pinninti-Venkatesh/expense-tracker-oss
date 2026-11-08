import config from './config.js';
import logger from './utils/logger.js';
import { isMailReady, isAccessRevoked } from './auth/mail-access.js';
import { requireContextUser } from './context.js';
import * as store from './drive/store.js';
import * as gmail from './gmail/client.js';
import { extractTransaction } from './llm/extract.js';
import { isFatalLlmError } from './llm/client.js';
import { withoutReview } from './llm/review.js';
import { screenAlert, isQuietSender, recordSender, looksLikeSpendSubject } from './gmail/prefilter.js';
import {
  findTemplateRead, aliasFor, canSkipModel, extractionFromTemplate, noteTemplateUse, learnFromModel, adoptShared,
} from './templates/alertLearning.js';
import * as library from './templates/library.js';
import * as users from './users/store.js';
import { applyRules, sameMerchant } from './learning/corrections.js';
import { allCategories } from './categories.js';
import { convertToInr, statedInInr } from './forex.js';
import { transferReason } from './transfers.js';
import { bankForSender } from './banks.js';

// Accounts with a poll in flight. A manual "Check email" and the scheduled run
// for the same account must not overlap; different accounts never block each other.
const running = new Set();

// When each account last finished a clean poll, for the "Updated 4 min ago"
// line. Kept in memory; the ledger keeps a coarser copy (meta.lastPollAt) that
// survives restarts and decides how far back the next poll has to read.
const lastSuccess = new Map();

export const lastSyncAt = (accountId, db = null) => lastSuccess.get(accountId) || db?.meta?.lastPollAt || null;

/* ---------- catching up after downtime ---------- */

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
// A server that was off (a sleeping laptop, a host that scales to zero, an
// outage) reads everything since its last clean poll, never just the last day.
// This caps how far: further back than this is what a first sync is for.
const MAX_CATCH_UP_DAYS = 92;
// Re-read this much before the last clean poll, for mail that arrived while it ran.
const OVERLAP_MS = HOUR_MS;
// The ledger's lastPollAt is written at most this often. The routine lookback
// (a day) already covers anything newer, so a fresher value would only cost a
// write per poll and change nothing.
const LAST_POLL_SAVE_MS = 6 * HOUR_MS;
// An email that keeps failing is retried by id on every poll, until it has
// failed this many times over at least a day. Then it is given up on, so one
// malformed email can't be paid for forever.
const GIVE_UP_ATTEMPTS = 5;
const GIVE_UP_AFTER_MS = DAY_MS;

/**
 * Where a routine poll starts reading: the usual lookback, or further back to
 * just before the last clean poll if the server has been away longer than that.
 */
export function pollWindowStart({ now = Date.now(), lastPollAt = null, lookbackHours = config.poll.lookbackHours } = {}) {
  const lookback = now - lookbackHours * HOUR_MS;
  const last = Date.parse(lastPollAt || '');
  if (!Number.isFinite(last)) return lookback;
  return Math.max(now - MAX_CATCH_UP_DAYS * DAY_MS, Math.min(lookback, last - OVERLAP_MS));
}

/** Marks an email decided, and stops retrying it if it had failed before. */
function markProcessed(d, id) {
  d.processedEmailIds.push(id);
  if (d.meta?.pendingEmails?.[id]) delete d.meta.pendingEmails[id];
}

/**
 * Records a failed attempt at an email. Returns true when this attempt gave up
 * on it: it is then marked processed and never retried.
 */
export function noteFailure(d, id, now = Date.now()) {
  d.meta ||= {};
  d.meta.pendingEmails ||= {};
  const entry = d.meta.pendingEmails[id] || { since: new Date(now).toISOString(), attempts: 0 };
  entry.attempts += 1;
  if (entry.attempts >= GIVE_UP_ATTEMPTS && now - Date.parse(entry.since) >= GIVE_UP_AFTER_MS) {
    delete d.meta.pendingEmails[id];
    d.processedEmailIds.push(id);
    return true;
  }
  d.meta.pendingEmails[id] = entry;
  return false;
}
export const isPolling = (accountId) => running.has(accountId);

// Some banks send two emails per charge, seconds apart. A window this tight
// catches the double-send while never merging genuine repeat purchases.
const DUP_WINDOW_MS = 5 * 60 * 1000;
// One charge can be announced by two different bank addresses hours apart, so
// that pairing is matched over a whole day rather than minutes.
const CROSS_SENDER_DUP_WINDOW_MS = 24 * 3600 * 1000;

export function newExpenseId() {
  return `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const isBank = (sender) => Boolean(sender && bankForSender(sender));

/**
 * The already-recorded expense that `candidate` is a second notification of,
 * or undefined: same amount, close together in time, and either the same
 * merchant or a merchant's receipt for a bank's charge. Requires both records
 * to carry an email timestamp, so it never fires on manual entries.
 */
export function findDuplicateNotification(expenses, candidate) {
  if (!candidate.at) return undefined;
  const t = new Date(candidate.at).getTime();

  return expenses.find((e) => {
    if (e.source !== 'email' || !e.at) return false;
    if (e.amount !== candidate.amount) return false;
    const gap = Math.abs(new Date(e.at).getTime() - t);
    const differentSender = Boolean(e.sender && candidate.sender && e.sender !== candidate.sender);

    // A payment gateway's or merchant's receipt and the bank's alert for the
    // same charge rarely share a merchant name ("Net Distribution Services" vs
    // "UPI NET Distribution"), so the amount and the day are what match them.
    if (differentSender && isBank(e.sender) !== isBank(candidate.sender)) {
      return gap <= CROSS_SENDER_DUP_WINDOW_MS;
    }
    // sameMerchant, not exact equality: two alerts for one charge parse the
    // name differently ("Anthropic" vs "Anthropic Claude").
    if (!sameMerchant(e.merchant, candidate.merchant)) return false;
    // Two DIFFERENT bank addresses reporting the same merchant and amount is one
    // charge announced twice, never two purchases.
    return gap <= (differentSender ? CROSS_SENDER_DUP_WINDOW_MS : DUP_WINDOW_MS);
  });
}

export const isDuplicateNotification = (expenses, candidate) => Boolean(findDuplicateNotification(expenses, candidate));

/**
 * Marks spends that are really transfers (transfers.js), on records made before
 * those rules existed. Runs once per ledger. A spend you've moved yourself
 * (`transferSetBy: 'you'`) is never changed, and receipts that duplicate a
 * bank's alert are removed, keeping the bank's record.
 */
export const TRANSFER_RULES_VERSION = 1;
export function applyTransferRules(d, holderName) {
  let marked = 0;
  for (const e of d.expenses) {
    if (e.transfer || e.transferSetBy === 'you') continue;
    if (e.source !== 'email' && e.source !== 'statement') continue;
    const reason = transferReason(e, { holderName, sender: e.sender });
    if (!reason) continue;
    e.transfer = true;
    e.transferReason = reason;
    delete e.needsReview;
    delete e.categoryOptions;
    marked++;
  }

  const receipts = d.expenses.filter((e) => e.source === 'email' && e.sender && !isBank(e.sender));
  const drop = new Set();
  for (const r of receipts) {
    const others = d.expenses.filter((e) => e !== r && !drop.has(e.id));
    const match = findDuplicateNotification(others, r);
    if (match && isBank(match.sender)) drop.add(r.id);
  }
  if (drop.size) d.expenses = d.expenses.filter((e) => !drop.has(e.id));

  d.meta ||= {};
  d.meta.transferRules = TRANSFER_RULES_VERSION;
  return { marked, receiptsRemoved: drop.size };
}

/** Records that every email up to `at` has been read (first sync or routine poll). */
export async function markPolledUpTo(at) {
  await store.mutate((d) => {
    d.meta ||= {};
    d.meta.lastPollAt = new Date(at).toISOString();
  });
}

/**
 * Fetch -> extract -> persist, for the account in context. Each accepted
 * expense is written through to Drive individually, so a failure partway leaves
 * earlier work durable.
 *
 * An email is marked processed when we reach a *decision* about it (spend or
 * not). Emails that error out are left unmarked so the next poll retries them.
 *
 * `limit` caps how many new emails one call reads, and `remaining` reports how
 * many are left. The first sync uses that to work through a month or two of
 * alerts in short requests the app repeats, rather than one long background
 * job: Cloud Run only guarantees CPU while a request is open. The routine poll
 * (no `afterEpoch`) reads from pollWindowStart(), in batches of
 * config.poll.batchSize, and also retries earlier failures by id.
 *
 * Logs carry ids and counts, never merchants or amounts: server logs are
 * retained and read by operators, and a user's spending is not theirs to see.
 */
export async function poll({ afterEpoch, label = 'poll', onProgress, limit, exclude = null } = {}) {
  const { id: accountId } = requireContextUser();
  if (running.has(accountId)) {
    logger.warn(`${label} skipped for ${accountId} — another run is in progress`);
    return { skipped: 'already_running' };
  }
  if (!isMailReady()) return { skipped: 'not_authenticated' };

  running.add(accountId);
  const routine = afterEpoch === undefined;
  const batchLimit = limit ?? (routine ? config.poll.batchSize : 0);
  const startedAt = Date.now();
  const result = { scanned: 0, added: 0, ignored: 0, screened: 0, fromTemplates: 0, failed: 0, alreadySeen: 0, duplicates: 0, remaining: 0 };
  const failedIds = [];

  try {
    let db = await store.init();
    // The account holder's name, from Google at sign-in: a payment to it is a
    // transfer to one of their own accounts.
    const holderName = ((await users.getUser(accountId)) || {}).name || '';
    // Ledgers from before the transfer rules get them applied once.
    if ((db.meta?.transferRules || 0) < TRANSFER_RULES_VERSION) {
      let outcome;
      await store.mutate((d) => { outcome = applyTransferRules(d, holderName); });
      logger.info(`Transfer rules applied for ${accountId}`, outcome);
      db = store.read();
    }
    // The account's name and email, fetched only if a template is offered to
    // the library: their words are scrubbed from it first.
    let person = null;
    const personOf = async () => (person ||= (await users.getUser(accountId)) || {});
    // Backfills pass an explicit window; the routine poll reads since it last
    // finished cleanly, or the usual lookback if that's more.
    const after = afterEpoch ?? Math.floor(pollWindowStart({ now: startedAt, lastPollAt: db.meta?.lastPollAt }) / 1000);
    const messages = await gmail.listMessages(after, db.knownSenders);
    result.scanned = messages.length;

    const seen = new Set(db.processedEmailIds);
    const unseen = messages.filter(({ id }) => !seen.has(id) && !exclude?.has(id));
    result.alreadySeen = messages.length - unseen.length;
    // Earlier failures, retried by id since they may be older than this window,
    // and always after new mail, so a few bad emails can't hold up a backlog.
    const pending = db.meta?.pendingEmails || {};
    if (routine) {
      const listed = new Set(unseen.map((m) => m.id));
      for (const id of Object.keys(pending)) {
        if (!seen.has(id) && !listed.has(id)) unseen.push({ id });
      }
    }
    unseen.sort((a, b) => Number(Boolean(pending[a.id])) - Number(Boolean(pending[b.id])));

    const batch = batchLimit > 0 ? unseen.slice(0, batchLimit) : unseen;
    result.remaining = unseen.length - batch.length;
    let processed = 0;

    for (const { id } of batch) {
      // Library updates found while learning from this email. The store's change
      // function is synchronous, so they are queued and run afterwards. Both kinds
      // are idempotent, so running them after a write that failed is harmless.
      const libraryJobs = [];
      try {
        const message = await gmail.getMessage(id);
        const sender = gmail.extractSender(message);
        const body = gmail.extractBody(message);
        const subject = gmail.extractSubject(message);

        // The search is wide so any bank's alerts are found, and the model is
        // billed per email. A free check first keeps OTPs, offers and
        // newsletters away from it, as does a sender that never sends spends.
        const quiet = isQuietSender(db.senderStats?.[sender]) && !looksLikeSpendSubject(subject);
        if (quiet || !screenAlert({ subject, body }).ok) {
          await store.mutate((d) => {
            markProcessed(d, id);
            recordSender(d, sender, false);
          });
          result.screened++;
          continue;
        }

        // A format this sender has used before may already have a proven
        // template, which reads the email for free. Only for senders Gmail
        // verified, so a spoofed alert can't train or use one.
        const text = `${subject}\n${body}`;
        const trusted = gmail.isAuthenticSender(message, sender);
        let hit = trusted ? findTemplateRead(db, sender, text) : null;
        // No format of this sender's is known here yet, but other accounts may
        // have proven one. It's adopted on trial: this account's own model still
        // has to agree with it before it reads anything alone.
        if (trusted && !hit && config.features.sharedTemplates) {
          const shared = await library.findShared(sender, text, { exclude: db.retiredSharedKeys }).catch((err) => {
            logger.warn('Template library lookup failed', err.message);
            return null;
          });
          if (shared) {
            await store.mutate((d) => { adoptShared(d, sender, shared); });
            hit = findTemplateRead(store.read(), sender, text);
          }
        }
        const alias = hit ? aliasFor(db, hit.fields.merchantRaw) : null;
        const fromTemplate = canSkipModel(hit, alias);

        const extracted = fromTemplate
          ? extractionFromTemplate(hit, alias)
          : await extractTransaction({
            sender,
            subject,
            body,
            corrections: db.corrections,
            categories: allCategories(db),
          });
        if (fromTemplate) result.fromTemplates++;

        // Runs inside each write below: count the template's use, or learn from
        // the model's answer (grading any template that also read the email).
        const learn = (d) => {
          let outcome = null;
          if (fromTemplate) noteTemplateUse(d, sender, hit.templateId);
          else if (trusted) outcome = learnFromModel(d, { sender, text, extracted, hit });

          const t = hit && (d.alertTemplates?.[sender] || []).find((x) => x.id === hit.templateId);
          if (outcome === 'retired' && t?.sharedKey) {
            libraryJobs.push(() => library.dispute(accountId, t.sharedKey));
          }
          // A format this account learned and proved is offered once. Adopted
          // formats are never offered back: they weren't learned independently.
          // With sharing off it stays unoffered, so turning sharing on later
          // still offers it.
          if (config.features.sharedTemplates && t && t.state === 'live' && t.origin !== 'shared' && !t.offeredAt) {
            t.offeredAt = new Date().toISOString();
            const snapshot = structuredClone(t);
            libraryJobs.push(async () => library.contribute(accountId, sender, snapshot, await personOf()));
          }
        };

        if (!extracted) {
          await store.mutate((d) => {
            markProcessed(d, id);
            recordSender(d, sender, false);
            learn(d);
          });
          result.ignored++;
          continue;
        }

        const ruled = applyRules(extracted, db.categoryRules);
        const withRules = ruled.categorySource === 'rule' ? withoutReview(ruled) : ruled;
        const txnDate = gmail.extractDate(message);

        // Foreign-currency charges arrive with the amount in the merchant's
        // currency. Convert to the INR the card actually debits so the figure
        // isn't silently stored as rupees.
        let amount = withRules.amount;
        let storedCurrency = 'INR';
        let description;
        let originalFields = {};
        let currency = (withRules.currency || 'INR').toUpperCase();
        // An international alert states both the foreign amount and the INR
        // debit. If the email calls this exact number rupees, it already is.
        if (currency !== 'INR' && statedInInr(body, withRules.amount)) {
          logger.warn(`Extractor labelled an amount ${currency} that the email states as INR; treating as rupees`);
          currency = 'INR';
        }
        if (currency !== 'INR') {
          try {
            const { inr, note } = await convertToInr(withRules.amount, currency, txnDate);
            amount = inr;
            description = note;
            originalFields = { originalAmount: withRules.amount, originalCurrency: currency };
          } catch (err) {
            // Degrade loudly: keep the foreign figure but label it, never pass
            // it off as rupees.
            storedCurrency = currency;
            description = `⚠ Billed in ${currency} ${withRules.amount} — automatic INR conversion failed (${err.message}); amount shown is the ${currency} value.`;
            logger.error(`FX conversion failed for a ${currency} charge`, err.message);
          }
        }

        const expense = {
          id: newExpenseId(),
          ...withRules,
          amount,
          currency: storedCurrency,
          ...originalFields,
          ...(description && { description }),
          date: txnDate,
          at: gmail.extractTimestamp(message),
          source: 'email',
          emailId: id,
          sender,
          isExpense: true,
          createdAt: new Date().toISOString(),
        };

        // Money moved to your own accounts, or out by bank transfer, is kept
        // but not counted as spending (transfers.js).
        const reason = transferReason(expense, { holderName, sender });
        if (reason) {
          expense.transfer = true;
          expense.transferReason = reason;
          delete expense.needsReview;
          delete expense.categoryOptions;
        }

        // A bank that double-sends alerts, or a merchant's receipt for a charge
        // the bank already reported, would otherwise record one charge twice.
        // Mark the email processed, but skip the insert.
        const duplicate = findDuplicateNotification(db.expenses, expense);
        if (duplicate) {
          // The bank's own alert is the better record (card, instrument, the
          // amount actually debited), so it replaces a receipt recorded first.
          const upgrade = !isBank(duplicate.sender) && isBank(sender) && duplicate.transferSetBy !== 'you';
          await store.mutate((d) => {
            markProcessed(d, id);
            if (upgrade) {
              const i = d.expenses.findIndex((e) => e.id === duplicate.id);
              if (i >= 0) d.expenses[i] = { ...expense, id: duplicate.id };
            }
            learn(d);
          });
          result.duplicates++;
          continue;
        }

        await store.mutate((d) => {
          d.expenses.push(expense);
          markProcessed(d, id);
          // Learn the sender so future polls can use the fast query path.
          if (!d.knownSenders.includes(sender)) d.knownSenders.push(sender);
          recordSender(d, sender, true);
          learn(d);
        });

        result.added++;
      } catch (err) {
        // Lost access fails every email the same way: report it for the whole
        // poll (the account is paused), not as this email's fault.
        if (isAccessRevoked(err)) throw err;

        logger.error(`Failed to process email ${id} for ${accountId}`, err.message);
        result.failed++;
        failedIds.push(id);

        // Dead model credentials fail every remaining email identically. Stop
        // rather than burning through the whole inbox.
        if (isFatalLlmError(err)) {
          result.abortedReason = err.message;
          break;
        }

        // Left unmarked so it is retried, by id, on later polls, until it has
        // clearly failed for good.
        let gaveUp = false;
        await store.mutate((d) => { gaveUp = noteFailure(d, id); })
          .catch((e) => logger.warn('Could not record a failed email', e.message));
        if (gaveUp) logger.warn(`Gave up on email ${id} for ${accountId} after repeated failures`);
      } finally {
        for (const job of libraryJobs) {
          await job().catch((err) => logger.warn('Template library update failed', err.message));
        }
        processed++;
        if (onProgress && (processed % 20 === 0 || processed === batch.length)) {
          onProgress({ processed, ...result });
        }
      }
    }

    // Bank statements are not read here. Opening one needs the PDF password,
    // which is never stored, so statements are imported on demand instead
    // (routes/upi.js).

    if (!result.abortedReason) {
      lastSuccess.set(accountId, new Date().toISOString());
      // Everything up to when this poll began has now been read, so the next
      // one can start there even after a restart.
      const saved = Date.parse(db.meta?.lastPollAt || '') || 0;
      if (routine && result.remaining === 0 && startedAt - saved >= LAST_POLL_SAVE_MS) {
        await markPolledUpTo(startedAt);
      }
    }
    if (batch.length || result.failed) logger.info(`${label} for ${accountId}`, result);
    return { ...result, failedIds };
  } catch (err) {
    logger.error(`Poll failed for ${accountId}`, err.message);
    return { ...result, failedIds, error: err.message };
  } finally {
    running.delete(accountId);
  }
}
