/**
 * A free check before the model.
 *
 * The alert search is wide so every bank is found, and the model is billed per
 * email. So each email must first look like a spend alert: an amount in rupees
 * and a word that means money went out. OTPs, offers and newsletters stop here.
 *
 * The check is deliberately loose — anything that passes still goes to the
 * model, which makes the real decision. It only has to never reject a real
 * alert, not to be precise.
 */

const MONEY = /(?:₹|\brs\.?|\binr)\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:inr\b|rs\b|rupees)/i;

const SPEND_WORDS = /\b(debited|debit|spent|charged|paid|payment|purchase|withdrawn|withdrawal|txn|transaction|sent|transferred|used)\b/i;

const SECURITY_SUBJECT = /\b(otp|one[\s-]?time password|verification code|password reset|login alert|new sign[\s-]?in)\b/i;

const SPEND_SUBJECT = /\b(debited|spent|txn alert|transaction alert|payment was made|charge just happened)\b/i;

/** { ok: true } when worth asking the model about, else { ok: false, reason }. */
export function screenAlert({ subject = '', body = '' } = {}) {
  if (SECURITY_SUBJECT.test(subject)) return { ok: false, reason: 'security' };
  const text = `${subject}\n${String(body).slice(0, 6000)}`;
  if (!MONEY.test(text)) return { ok: false, reason: 'no_amount' };
  if (!SPEND_WORDS.test(text)) return { ok: false, reason: 'no_spend_words' };
  return { ok: true };
}

/** A subject that says outright a spend happened is always worth reading. */
export const looksLikeSpendSubject = (subject) => SPEND_SUBJECT.test(String(subject || ''));

// Emails a sender must send with no spend among them before it stops being read.
const QUIET_AFTER = 8;

/**
 * A sender that has only ever sent things that weren't spends — a bank's
 * marketing address, a shop's newsletter — stops reaching the model. One spend
 * from it, ever, and it is never quiet again.
 */
export function isQuietSender(stats) {
  return Boolean(stats) && stats.spends === 0 && stats.others >= QUIET_AFTER;
}

/** Tallies what a sender sent, in place on the ledger. */
export function recordSender(db, sender, wasSpend) {
  if (!sender) return;
  db.senderStats ||= {};
  const stats = (db.senderStats[sender] ||= { spends: 0, others: 0 });
  if (wasSpend) stats.spends += 1;
  else stats.others += 1;
}
