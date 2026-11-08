import { bankForSender } from './banks.js';

/**
 * Money that moves without being spent: to your own accounts, into a savings
 * pot, or out by bank transfer. These are recorded, so nothing silently
 * disappears, but marked `transfer`, which keeps them out of every spending
 * total and lists them under "Not spending", where one tap counts one back.
 *
 * The rules follow what an account holder's own ledger counts as spending: card
 * charges and UPI payments to shops and people. Moving money between their own
 * accounts, or out of an account by NEFT/IMPS/RTGS, isn't.
 */

/** Words that come before a name on alerts and statements but aren't part of it. */
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'sri', 'smt', 'kumari', 'master']);

const nameWords = (text) => String(text || '')
  .toLowerCase()
  .replace(/[^a-z\s]/g, ' ')
  .split(/\s+/)
  .filter((w) => w && !HONORIFICS.has(w));

/**
 * True when `payee` is the account holder: every word of their name appears,
 * and nothing else except initials. Needs at least two words of three or more
 * letters, because a first name alone is shared with too many people.
 *
 *   isOwnName('MR RAO ASHA', 'Asha Rao')         → true
 *   isOwnName('Asha Traders', 'Asha Rao')        → false
 */
export function isOwnName(payee, holderName) {
  const own = nameWords(holderName).filter((w) => w.length >= 3);
  if (own.length < 2) return false;
  const words = nameWords(payee);
  if (!own.every((w) => words.includes(w))) return false;
  return words.every((w) => own.includes(w) || w.length === 1);
}

/**
 * A savings pot, jar, sweep or deposit: the holder's own money, parked. The
 * whole name has to be the pot ("Jupiter Pot", "Savings Pot"), so a shop
 * called "Hot Pot Kitchen" isn't one, and a card purchase never is.
 */
const OWN_MONEY_MOVE = /^(?:[a-z]+\s+)?(?:savings\s+)?(?:pot|jar)s?$|\bsweep[\s-]?(?:in|out)\b|\b(?:fixed|recurring)\s+deposit\b/i;
const CARD = /card/i;

/**
 * Why a spend read from email or a statement is really a transfer, or null.
 *
 * `expense` needs merchant and paymentType; `sender` is the email's From
 * address; `holderName` is the signed-in account's name.
 */
export function transferReason({ merchant, paymentType, counterparty } = {}, { holderName, sender } = {}) {
  if (isOwnName(merchant, holderName) || (counterparty && isOwnName(counterparty, holderName))) return 'own-account';
  if (!CARD.test(paymentType || '') && OWN_MONEY_MOVE.test(String(merchant || '').trim())) return 'own-account';
  // An account debit by net banking is a bank transfer, not a purchase. Only
  // for a bank's own alert: a merchant's receipt saying "paid by net banking"
  // is still a purchase.
  if (paymentType === 'Net Banking' && (!sender || bankForSender(sender))) return 'bank-transfer';
  return null;
}
