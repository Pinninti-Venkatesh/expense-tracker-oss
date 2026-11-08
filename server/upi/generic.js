/**
 * Reading a statement from any bank, without a parser written for its layout.
 *
 * The model reads the transaction table. Everything in this file decides what
 * the model is shown, and checks what it answers against the statement itself,
 * so a misread or invented row never becomes a spend. Pure functions, no model.
 */

const DAY_MS = 24 * 3600 * 1000;

// A transaction table's header: a date column and a money or narration column.
const TABLE_HEADER = /\b(date|txn date|value date|tran date)\b.*\b(withdrawals?|debits?|dr|amount|particulars|narration|description|details|remarks)\b/i;

// Page furniture that repeats on every page and carries personal details. Kept
// out of the prompt: the model needs the table, not who the account belongs to.
const PERSONAL = /^(customer name|name\b|address|account (no|number)|a\/c (no|number)|cif|customer id|ifsc|micr|branch|e-?mail|mobile|phone|nominee|joint holder|pan\b|ckyc)/i;

/** 'bank_account', 'credit_card', 'investment' or 'unknown'. */
export function classifyStatement(lines) {
  const text = lines.join('\n');
  if (/minimum (amount )?due|total amount due|credit limit/i.test(text)) return 'credit_card';
  if (/\bfolio\b|\bNAV\b|units? balance|\bdemat\b|mutual fund|consolidated account statement/i.test(text)) return 'investment';
  if (/opening balance|closing balance|withdrawals?|deposits?|available balance|\bdebits?\b/i.test(text)) return 'bank_account';
  return 'unknown';
}

/**
 * The lines worth showing the model: from the first table header on, without
 * personal details. Each keeps its index in the whole statement, so an answer
 * can be checked against the exact line it cites.
 */
export function transactionRegion(lines) {
  const header = lines.findIndex((l) => TABLE_HEADER.test(l));
  const out = [];
  for (let i = header === -1 ? 0 : header; i < lines.length; i++) {
    const text = String(lines[i]).trim();
    if (!text || PERSONAL.test(text)) continue;
    out.push({ index: i, text });
  }
  return out;
}

/** Fixed-size slices that overlap slightly, so a row wrapping across a boundary is seen whole. */
export function overlappingChunks(rows, size = 120, overlap = 4) {
  const out = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < rows.length; i += step) {
    out.push(rows.slice(i, i + size));
    if (i + size >= rows.length) break;
  }
  return out;
}

/** True when this exact amount is printed in the text: 500 is not in "1,500.00" or "500.50". */
export function amountAppears(amount, text) {
  const n = Number(amount);
  if (!(n > 0)) return false;
  const numbers = String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  return numbers.some((x) => Math.abs(Number(x) - n) < 0.005);
}

/**
 * Checks one debit the model reported. It must cite a real line, its amount must
 * be printed on that line or the few around it (rows wrap, and some layouts put
 * the date just above), and its date must fall in the statement's period.
 * Returns a cleaned row, or null to drop it.
 */
export function verifyDebit(row, lines, statementDate) {
  const line = Number(row?.line);
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;

  const amount = Math.round(Number(row.amount) * 100) / 100;
  const nearby = lines.slice(Math.max(0, line - 1), line + 4).join(' ');
  if (!amountAppears(amount, nearby)) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))) return null;
  const when = Date.parse(`${row.date}T00:00:00Z`);
  if (Number.isNaN(when)) return null;
  const anchor = Date.parse(`${statementDate}T00:00:00Z`);
  if (!Number.isNaN(anchor) && (when > anchor + 2 * DAY_MS || when < anchor - 400 * DAY_MS)) return null;

  const balance = row.balance === null || row.balance === undefined || row.balance === '' ? null : Number(row.balance);
  return {
    line,
    date: row.date,
    amount,
    description: String(row.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    reference: row.reference ? String(row.reference).trim().slice(0, 60) : null,
    balance: Number.isFinite(balance) ? Math.round(balance * 100) / 100 : null,
  };
}

/** How the money left, read from the narration. */
export function railFromText(text) {
  const t = String(text || '').toUpperCase();
  if (/\bUPI\b|UPI\//.test(t)) return 'UPI';
  if (/\bIMPS\b/.test(t)) return 'IMPS';
  if (/\bNEFT\b/.test(t)) return 'NEFT';
  if (/\bRTGS\b/.test(t)) return 'RTGS';
  if (/\bATM\b|CASH WDL|\bNWD\b/.test(t)) return 'ATM';
  if (/\bNACH\b|\bACH\b|\bECS\b/.test(t)) return 'ACH';
  if (/\bPOS\b|DEBIT CARD|\bVISA\b|\bRUPAY\b/.test(t)) return 'Debit Card';
  if (/\bCHRGS?\b|CHARGES?\b|\bFEE\b|\bGST\b/.test(t)) return 'Charge';
  return 'Bank';
}

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Keys that recognise this transaction on a later import. Same shapes as the
 * built-in parser's (upi/statement.js), so the two paths never double-count.
 * With neither a reference nor a balance, the narration and the row's position
 * among identical rows stand in — two ₹50 coffees at one shop on one day are two.
 */
export function genericKeys(row, occurrence = 1) {
  const keys = [];
  if (row.reference) keys.push(`ref:${row.reference}|${row.date}|${row.amount}`);
  if (row.balance !== null && row.balance !== undefined) keys.push(`bal:${row.date}|${row.amount}|${row.balance}`);
  if (!keys.length) keys.push(`txt:${row.date}|${row.amount}|${normalise(row.description)}|${occurrence}`);
  return keys;
}

/**
 * A bank alert already recorded for this statement row: same amount, within a
 * day, and not a credit card charge (those never touch the bank account).
 * `claimed` holds alerts already matched in this import, so one alert can't
 * stand in for two rows.
 */
export function findMatchingAlert(expenses, row, claimed = new Set()) {
  const when = Date.parse(`${row.date}T00:00:00Z`);
  return expenses.find((e) => e.source === 'email'
    && !claimed.has(e.id)
    && e.isExpense !== false
    && !/credit/i.test(e.paymentType || '')
    && Math.abs(Number(e.amount) - Number(row.amount)) < 0.01
    && Math.abs(Date.parse(`${e.date}T00:00:00Z`) - when) <= DAY_MS) || null;
}

const HINT_CUE = /date of birth|\bdob\b|ddmm|dd\/mm|first (four|4)|last (four|4)|letters|digits|characters|\bpan\b|customer id|mobile number|capital|lower ?case|upper ?case|format/i;

/**
 * The sentence in a statement email that says how its password is made, e.g.
 * "the first four letters of your name followed by your date of birth". Never
 * the "don't share your password" boilerplate.
 */
export function passwordHint(body) {
  const sentences = String(body || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => /password/i.test(s) && HINT_CUE.test(s));
  return hit ? hit.trim().slice(0, 240) : null;
}
