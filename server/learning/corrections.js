/**
 * The learning loop.
 *
 * Two mechanisms, deliberately separated:
 *
 *   Rules      — deterministic overrides. A merchant->category fix you made once
 *                is applied before the LLM is consulted, so it can never be
 *                re-litigated and costs nothing.
 *   Few-shot   — worked examples injected into the extraction prompt, for
 *                corrections that cannot be expressed as a lookup ("this was a
 *                refund, not a spend", "the 40 rupees is a platform fee").
 *
 * A correction becomes a rule only when the category was the sole thing wrong.
 * Anything else is nuance the model has to reason about, so it goes to few-shot.
 */

const MAX_FEW_SHOT = 25;

/** Merchants arrive as "SWIGGY BANGALORE IN", "Swiggy", "swiggy*order" — normalise before matching. */
export function merchantKey(merchant) {
  return String(merchant || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fields that describe the MERCHANT rather than one purchase, so they are safe
 * to copy onto every other charge from that merchant.
 *
 * `amount` and `date` are deliberately excluded: they are facts about a single
 * transaction, and propagating them would overwrite real data on every row.
 */
export const PROPAGATABLE = ['category', 'merchant', 'isExpense'];

/**
 * Other expenses from the same merchant. Matched on the ORIGINAL name, because
 * the correction may be renaming the merchant — matching on the new name would
 * find nothing.
 */
/**
 * Whether two merchant strings are the same business.
 *
 * Exact key equality is not enough: the same merchant arrives as "Zomato",
 * "ZOMATO BANGALORE IN" and "zomato*order" depending on the bank's descriptor.
 * So the shorter key matches when it appears in the longer one on a WORD
 * boundary — that catches the descriptor noise without letting "zom" match
 * anything containing those letters. Consistent with how applyRules already
 * resolves a rule key against an incoming merchant.
 */
export function sameMerchant(a, b) {
  const x = merchantKey(a);
  const y = merchantKey(b);
  if (!x || !y) return false;
  if (x === y) return true;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 3) return false; // too generic to be evidence of anything

  return long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `);
}

export function matchingExpenses(db, merchant, excludeId) {
  if (!merchantKey(merchant)) return [];
  return db.expenses.filter((e) => e.id !== excludeId && sameMerchant(e.merchant, merchant));
}

/** Copies the merchant-level parts of a correction onto every sibling row. */
export function applyToMatching(db, { merchant, corrected, excludeId, at }) {
  const patch = {};
  for (const field of PROPAGATABLE) {
    if (field in corrected) patch[field] = corrected[field];
  }
  if (!Object.keys(patch).length) return [];

  const targets = matchingExpenses(db, merchant, excludeId);
  for (const expense of targets) {
    Object.assign(expense, patch, { corrected: true, correctedAt: at });
  }
  return targets.map((e) => e.id);
}

/** True when `category` is the only field the user changed. */
export function isCategoryOnlyChange(before, after) {
  const fields = ['merchant', 'amount', 'date', 'bank', 'paymentType', 'isExpense'];
  const othersUnchanged = fields.every((f) => {
    if (!(f in after)) return true;
    return String(before?.[f] ?? '') === String(after[f] ?? '');
  });
  return othersUnchanged && 'category' in after && before?.category !== after.category;
}

/**
 * Applies learned category rules. Exact key match first, then substring — so a
 * rule on "amazon" also catches "amazon pay india pvt ltd".
 */
export function applyRules(extracted, categoryRules = {}) {
  const key = merchantKey(extracted.merchant);
  if (!key) return extracted;

  if (categoryRules[key]) {
    return { ...extracted, category: categoryRules[key], categorySource: 'rule' };
  }

  for (const [ruleKey, category] of Object.entries(categoryRules)) {
    if (ruleKey && key.includes(ruleKey)) {
      return { ...extracted, category, categorySource: 'rule' };
    }
  }

  return extracted;
}

/**
 * Renders corrections as prompt examples. Newest first and capped — an
 * unbounded list would eventually crowd out the email being classified.
 */
export function buildFewShot(corrections = [], limit = MAX_FEW_SHOT) {
  const relevant = corrections
    .filter((c) => c.reason)
    .slice(-limit)
    .reverse();

  if (!relevant.length) return '';

  const examples = relevant
    .map((c, i) => {
      const got = JSON.stringify(c.before ?? {});
      const want = JSON.stringify(c.after ?? {});
      return `${i + 1}. I extracted ${got}\n   The user corrected this to ${want}\n   Their reason: "${c.reason}"`;
    })
    .join('\n\n');

  return (
    `\n\nPAST CORRECTIONS FROM THIS USER — apply the same reasoning when it is relevant:\n\n` +
    `${examples}\n\n` +
    `These are corrections to your own past mistakes. Do not repeat them.`
  );
}

/**
 * Records a correction against the in-memory db. Returns a summary of what was
 * learned. Caller is responsible for persisting (store.mutate does that).
 */
export function recordCorrection(db, { expenseId, reason, corrected }) {
  const expense = db.expenses.find((e) => e.id === expenseId);
  if (!expense) throw new Error(`No expense with id ${expenseId}`);

  const before = {
    merchant: expense.merchant,
    amount: expense.amount,
    date: expense.date,
    category: expense.category,
    bank: expense.bank,
    paymentType: expense.paymentType,
    isExpense: expense.isExpense !== false,
  };
  const after = { ...before, ...corrected };

  const correction = {
    id: `cor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    expenseId,
    at: new Date().toISOString(),
    reason: reason || null,
    before,
    after,
  };
  db.corrections.push(correction);

  Object.assign(expense, corrected, { corrected: true, correctedAt: correction.at });

  let learnedRule = null;
  if (isCategoryOnlyChange(before, after)) {
    const key = merchantKey(after.merchant);
    if (key) {
      db.categoryRules[key] = after.category;
      learnedRule = { merchant: key, category: after.category };
    }
  }

  return { correction, learnedRule };
}
