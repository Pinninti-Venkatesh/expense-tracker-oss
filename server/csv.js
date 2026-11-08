import { effectiveAmount, owedToYou } from './splits.js';

/**
 * The ledger as a spreadsheet, so leaving never means losing your history.
 *
 * One row per transaction, newest first, with "your cost" alongside the charged
 * amount because splits and refunds make them differ.
 */
const COLUMNS = [
  ['date', (e) => e.date],
  ['merchant', (e) => e.merchant],
  ['amount', (e) => e.amount],
  ['your_cost', (e) => effectiveAmount(e)],
  ['category', (e) => e.category],
  ['payment_type', (e) => e.paymentType],
  ['bank', (e) => e.bank],
  ['card_last4', (e) => e.cardLast4],
  ['source', (e) => e.source],
  ['not_spending', (e) => (e.transfer || e.isExpense === false ? 'yes' : '')],
  ['owed_to_you', (e) => owedToYou(e) || ''],
  ['refunded', (e) => (e.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0) || ''],
  ['note', (e) => e.note],
  ['description', (e) => e.description],
];

/**
 * Quotes a cell when it needs it, and defuses spreadsheet formulas: a merchant
 * called "=HYPERLINK(...)" must open as text, not run.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function expensesToCsv(expenses = []) {
  const rows = [...expenses].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const lines = [COLUMNS.map(([name]) => name).join(',')];
  for (const e of rows) lines.push(COLUMNS.map(([, get]) => csvCell(get(e))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
