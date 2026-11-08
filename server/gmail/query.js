import { BANK_DOMAINS, bankForSender } from '../banks.js';

/**
 * The Gmail search for transaction alerts, from any bank. Three ways in:
 *
 *   1. From a known bank domain (see banks.js), or a sender that has sent a
 *      spend before.
 *   2. A subject that names a transaction.
 *   3. Body wording alerts use, for banks whose subjects say nothing useful.
 *
 * It is wide on purpose. What keeps it cheap is prefilter.js, which screens
 * every email before the model sees it.
 */

// Each phrase is quoted: Gmail parses an unquoted multi-word OR list as a
// conjunction, silently missing "YES BANK - Transaction Alert".
const SUBJECT_PHRASES = [
  'transaction alert', 'txn alert', 'credit card', 'debit card', 'has been spent', 'has been debited',
  'debited', 'spent', 'charge just happened', 'payment was made', 'upi', 'transaction successful',
  'payment successful', 'purchase',
];

const BODY_PHRASES = [
  'has been debited', 'debited from', 'debited by', 'is debited', 'spent on your', 'used for a transaction',
  'transaction of rs', 'transaction of inr',
];

// Learned senders beyond the bank list, most recent kept, so the query stays a
// sensible length however many senders an inbox turns up.
const MAX_EXTRA_SENDERS = 150;

export function buildQuery(afterEpochSeconds, knownSenders = []) {
  const extra = [...new Set(knownSenders)].filter((s) => !bankForSender(s)).slice(-MAX_EXTRA_SENDERS);
  const senders = [...BANK_DOMAINS, ...extra];

  const fromBank = `(${senders.map((s) => `from:${s}`).join(' OR ')})`;
  const byWording = `((subject:(${SUBJECT_PHRASES.map((p) => `"${p}"`).join(' OR ')}) OR ` +
    `(${BODY_PHRASES.map((p) => `"${p}"`).join(' OR ')})) -category:promotions -category:social)`;

  // Promotions are excluded only for the wording clauses: a bank's own alerts
  // occasionally get filed there, and those still come in through the sender.
  return `(${fromBank} OR ${byWording}) -subject:otp after:${afterEpochSeconds}`;
}
