/**
 * Bank-account debits from statement PDFs in the user's Gmail, from any bank.
 *
 *   Gmail (a statement-like subject, or a configured sender, with a PDF)
 *     -> open with the password typed for that bank in this import (never stored)
 *     -> extract text lines (pdf.js)
 *     -> skip credit card and investment statements: card spends come from alerts
 *     -> a layout with a built-in parser (Federal Bank / Jupiter) is read exactly,
 *        with no model. Any other layout is read by the model, and every row it
 *        returns is checked against the line it cites (upi/generic.js)
 *     -> tag learned self-transfer payees (db.statementIgnores)
 *     -> skip rows already imported, and rows a bank alert already recorded
 *     -> write through to Drive, once per statement
 *
 * These are real account debits (the money has left), so they carry no "settle"
 * concept. Categories come from the learned merchant->category rules; unmatched
 * land in 'General'.
 */
import config from '../config.js';
import logger from '../utils/logger.js';
import * as store from '../drive/store.js';
import * as gmail from '../gmail/client.js';
import { extractTextLines, probePdf } from './pdf.js';
import { applyRules } from '../learning/corrections.js';
import { newExpenseId } from '../poll.js';
import { serialisePerUser } from '../utils/user-queue.js';
import { bankLabelForSender } from '../banks.js';
import { transferReason } from '../transfers.js';
import { requireContextUser } from '../context.js';
import * as users from '../users/store.js';
import { readStatementChunk } from '../llm/statement.js';
import { savedPasswords } from './saved-passwords.js';
import {
  classifyStatement, transactionRegion, overlappingChunks, verifyDebit, railFromText,
  genericKeys, findMatchingAlert, passwordHint,
} from './generic.js';
import { learnLayout, parseWithLayout, sameDebits, gradeLayout, layoutSkipsModel } from '../templates/layouts.js';

// Documents that arrive with "statement"-ish subjects and PDFs but hold no bank
// account transactions. Excluding them in the query is cheaper than opening each.
const NOT_A_STATEMENT = [
  '"deposit advice"', '"interest certificate"', '"tds certificate"', '"purchase invoice"',
  '"loan agreement"', '"contract note"', '"capital gain"', '"credit card"', '"card statement"',
  '"mutual fund"', '"demat"', '"insurance"',
];

// Investment registrars and depositories send "statements" that are not bank accounts.
const NOT_BANK_SENDERS = ['camsonline.com', 'kfintech.com', 'nsdl.co.in', 'cdslindia.com', 'cdslstatement.com'];

const STATEMENT_SUBJECTS = ['statement', 'e-statement', 'estatement', 'account summary'];

/** Gmail search for bank statement emails with a PDF attachment, from any bank. */
function statementQuery(afterEpoch) {
  // A statement cannot contain transactions from after it was sent, so an
  // optional configured floor safely bounds how far back the search reaches.
  const floor = config.upi.since ? Math.floor(new Date(`${config.upi.since}T00:00:00Z`).getTime() / 1000) : 0;
  const after = Math.max(Number(afterEpoch) || 0, floor);
  const ways = [
    ...config.upi.statementSenders.map((v) => `from:${v}`),
    ...STATEMENT_SUBJECTS.map((s) => `subject:"${s}"`),
  ];
  return [
    `(${ways.join(' OR ')})`,
    'has:attachment',
    'filename:pdf',
    ...NOT_A_STATEMENT.map((v) => `-subject:${v}`),
    ...NOT_BANK_SENDERS.map((v) => `-from:${v}`),
    `after:${after}`,
  ].join(' ');
}

// Headroom for a year of monthly statements from several banks. Known ids are
// discarded before anything is fetched, so a longer list is cheap.
const STATEMENT_SEARCH_LIMIT = 60;

/** Candidate statement message ids — one Gmail call, no message bodies. */
async function statementMessageIds(afterEpoch) {
  return gmail.searchMessageIds(statementQuery(afterEpoch), { maxResults: STATEMENT_SEARCH_LIMIT });
}

export const statementBankLabel = bankLabelForSender;

const isPdf = (a) => /pdf$/i.test(a.filename) || a.mimeType === 'application/pdf';

/** Turns ids into {from, subject, date, hint, attachments}, keeping only those with a PDF. */
async function hydrateStatements(ids) {
  const messages = await gmail.getMessages(ids);
  return messages.map((m) => ({
    id: m.id,
    from: gmail.extractSender(m),
    subject: gmail.extractSubject(m),
    date: gmail.extractDate(m),
    hint: passwordHint(gmail.extractBody(m)),
    attachments: gmail.listAttachments(m).filter(isPdf),
  })).filter((m) => m.attachments.length);
}

/** Lists candidate statement emails; downloads nothing. */
export async function findStatementEmails(afterEpoch) {
  return hydrateStatements(await statementMessageIds(afterEpoch));
}

/** 'locked', 'open' or 'broken' for a statement's PDF. Downloads it, reads no text. */
export async function probeStatement(email) {
  const pdf = email.attachments[0];
  if (!pdf) return 'broken';
  try {
    return await probePdf(await gmail.getAttachment(email.id, pdf.attachmentId));
  } catch {
    return 'broken';
  }
}

/** Downloads and opens the first PDF on a message and returns its text lines. */
export async function extractStatementText(messageOrId, password) {
  const message = typeof messageOrId === 'string' ? await gmail.getMessage(messageOrId) : messageOrId;
  const pdf = gmail.listAttachments(message).find(isPdf);
  if (!pdf) throw new Error('No PDF attachment on that email');
  const bytes = await gmail.getAttachment(message.id, pdf.attachmentId);
  const { lines, pages } = await openStatement(bytes, password);
  return { filename: pdf.filename, lines, pageCount: pages.length };
}

/**
 * Opens the PDF with the password supplied for this import. A rejected or
 * missing password is reported as such; anything else is a real failure and
 * rethrown, so a corrupt PDF doesn't look like a wrong key.
 */
async function openStatement(bytes, password) {
  try {
    return await extractTextLines(bytes, password);
  } catch (err) {
    if (/password/i.test(err.message)) {
      const wrong = new Error(password ? 'That password did not open the statement PDF.' : 'This statement needs its password.');
      wrong.wrongPassword = true;
      throw wrong;
    }
    throw err;
  }
}

/* ---------- the built-in parser: Federal Bank and Jupiter layouts ---------- */

// Two layouts reach us for the same account. Both open with a posting date and
// a value date; they part company at the tail:
//
//   classic  … <tran id> <withdrawal> <deposits> <balance> <CR|DR>
//   partner  … <tran type> <amount> <balance> <Dr|Cr>
//
// The partner template has no per-transaction id column at all, and its PDF
// omits empty cells rather than spacing them, so a row carries one amount instead
// of two and only the Dr/Cr flag says whether it went out or came in.
const DATES = String.raw`^(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+`;
const MONEY = String.raw`([\d,]*\.?\d+)`;
const BALANCE = String.raw`([\d,]+(?:\.\d{2})?)`;

const CLASSIC = new RegExp(`${DATES}(.+?)\\s+([A-Z]\\d{5,})\\s+${MONEY}\\s+${MONEY}\\s+${BALANCE}\\s+(CR|DR)\\s*$`);
const PARTNER = new RegExp(`${DATES}(.+?)\\s+([A-Z]{2,6})\\s+${MONEY}\\s+${BALANCE}\\s+(Cr|CR|Dr|DR)\\s*$`);

// Page furniture and section headers that appear between transactions. Any of
// it landing in `cont` would be glued onto the previous row's particulars —
// which is where the reference is read from, so it has to be excluded by name.
const NOISE = /^(ACCOUNT STATEMENT|Customer ID|Statement Period|Statement of account|Transaction Details|Savings Account|Customer Name|Available Balance|Value Tran|Date Particulars|Date Type|Date Value Date|Opening Balance|Closing Balance|GRAND TOTAL|Important Message|Abbreviations|Disclaimer|24x7|24\*7|contact@federal|The Federal Bank|Phone number|www\.federal|1800 ?\d|Page |\d+\s*$|\.\s*$)/i;

/**
 * A transaction's own reference, for the layout that has no tran-id column.
 * The rail writes its reference into the particulars — a UPI RRN, an IMPS
 * sequence, a NEFT UTR. Rows with nothing usable fall back to the running
 * balance, which is unique to one transaction in an account's history.
 */
function extractRef(raw, balance) {
  const ids = raw.split(/[/\s]+/)
    .map((p) => p.trim())
    .filter((p) => /^[A-Za-z0-9]{10,}$/.test(p) && /\d/.test(p));
  if (ids.length) return ids.sort((a, b) => b.length - a.length)[0];
  return `bal${balance}`;
}

const num = (x) => Number(String(x).replace(/,/g, ''));

/** Joins wrapped particulars fragments, honouring the soft-wrap hyphen. */
function joinParticulars(start, cont) {
  let s = start;
  for (const frag of cont) {
    if (s.endsWith('-')) s = s.slice(0, -1) + frag; // soft-wrap: drop hyphen, no space
    else s += ` ${frag}`;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The most identifying, stable token for the counterparty — used for display and
 * as the key the "move to transfers" learning matches on: a UPI VPA, else a
 * bank/account code (e.g. SBIN0000874), else a name-ish fallback.
 */
export function extractCounterparty(raw) {
  const vpa = raw.replace(/\s+/g, '').match(/([a-z0-9.\-]+@[a-z]+)/i);
  if (vpa) return vpa[1];
  const acct = raw.match(/\b([A-Z]{4}\d{6,})\b/);
  if (acct) return acct[1];
  const nameish = raw
    .replace(/^[A-Z ]+\//, '') // drop the leading rail token
    .replace(/\d{4,}/g, ' ') // drop long reference numbers
    .replace(/[^A-Za-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return nameish ? nameish.slice(0, 30) : null;
}

/** Rail label from the leading particulars token, for paymentType. */
function railOf(type) {
  const t = (type || '').toUpperCase();
  if (t.startsWith('UPIOUT') || t.startsWith('UPI')) return 'UPI';
  if (t.includes('IMPS')) return 'IMPS';
  if (t.includes('NEFT') || t.startsWith('NFT')) return 'NEFT';
  if (t.includes('RTG')) return 'RTGS';
  if (t.includes('ATM')) return 'ATM';
  if (t.startsWith('ACH')) return 'ACH';
  if (t.startsWith('CHRG') || t.startsWith('CHG')) return 'Charge';
  return 'Bank';
}

const isIgnoredPayee = (text, ignores) => {
  const hay = String(text || '').toLowerCase();
  return (ignores || []).map((i) => String(i).toLowerCase()).filter(Boolean).some((ig) => hay.includes(ig));
};

/**
 * Parses statement text lines in the Federal Bank / Jupiter layouts into debit
 * rows { date, amount, ref, type, raw, counterparty, narration }. Keeps every
 * withdrawal; skips credits and every non-transaction line. `ignores` tags
 * learned self-transfer payees. Deterministic, no model. Returns no rows for
 * any other layout.
 */
export function parseStatement(lines, ignores = []) {
  const rows = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.isDebit) {
      const raw = joinParticulars(cur.startParticulars, cur.cont);
      const counterparty = extractCounterparty(raw);
      rows.push({
        date: cur.date,
        amount: cur.amount,
        balance: cur.balance,
        // The classic layout gives a per-transaction id outright; the partner
        // layout has none, so it is recovered from the joined particulars.
        ref: cur.tranId ?? extractRef(raw, cur.balance),
        type: cur.type,
        raw,
        counterparty,
        narration: counterparty || `${cur.type} ${raw}`.slice(0, 40),
      });
    }
    cur = null;
  };

  for (const line of lines.map((l) => String(l).trim())) {
    // Classic first: its shape is the more specific of the two, so a row that
    // satisfies it is never also read as a partner row.
    const classic = CLASSIC.exec(line);
    const partner = classic ? null : PARTNER.exec(line);

    if (classic) {
      flush();
      const [, dd, mm, yyyy, middle, tranId, wd, dep, bal] = classic;
      const withdrawal = num(wd);
      const deposits = num(dep);
      cur = {
        date: `${yyyy}-${mm}-${dd}`,
        amount: withdrawal,
        tranId,
        balance: num(bal),
        type: (middle.split('/')[0] || '').trim(),
        isDebit: withdrawal > 0 && deposits === 0,
        startParticulars: middle.replace(/\s+[A-Z]{2,5}$/, ''), // drop trailing tran-type token
        cont: [],
      };
    } else if (partner) {
      flush();
      const [, dd, mm, yyyy, middle, , amt, bal, drcr] = partner;
      const amount = num(amt);
      cur = {
        date: `${yyyy}-${mm}-${dd}`,
        amount,
        tranId: null, // resolved from the particulars in flush(), once joined
        balance: num(bal),
        type: (middle.split('/')[0] || '').trim(),
        // One amount column, so position says nothing: Dr is money out, Cr is
        // money in. Reading a Cr as a spend would book a salary as an expense.
        isDebit: /^dr$/i.test(drcr) && amount > 0,
        startParticulars: middle,
        cont: [],
      };
    } else if (cur && !NOISE.test(line)) {
      cur.cont.push(line);
    } else {
      flush();
    }
  }
  flush();

  // A learned self-transfer payee tags the row rather than deleting it. Money
  // moving between your own accounts is still worth being able to see, and once
  // in a while one of them is a genuine spend.
  const tagged = rows.map((r) => (isIgnoredPayee(r.raw, ignores) ? { ...r, isTransfer: true } : r));
  return { rows: tagged, ignoredCount: tagged.filter((r) => r.isTransfer).length };
}

/**
 * Every key under which one parsed transaction may already be recorded. A row
 * counts as seen if any matches, and all are stored when it is added.
 *
 *   ref  the rail's own reference plus date and amount. A bank can reuse one
 *        tran id for a purchase AND its fee, so the id alone is not unique.
 *
 *   bal  date, amount and the running balance. The same transaction carries
 *        different references in different statement templates; the balance is
 *        a fact of the account, identical in both, and unique per transaction.
 */
export function dedupKeys(row) {
  return [
    `ref:${row.ref}|${row.date}|${row.amount}`,
    `bal:${row.date}|${row.amount}|${row.balance}`,
  ];
}

/* ---------- any other layout: the model reads, generic.js checks ---------- */

// A year's statement runs to a few dozen pages; this bounds a runaway PDF.
const MAX_MODEL_CHUNKS = 30;

async function readWithModel(lines, statementDate, ignores) {
  const region = transactionRegion(lines);
  const year = Number(String(statementDate).slice(0, 4)) || new Date().getFullYear();
  const found = new Map();
  let documentType = 'bank_account';
  let unverified = 0;

  const slices = overlappingChunks(region).slice(0, MAX_MODEL_CHUNKS);
  for (let i = 0; i < slices.length; i++) {
    const answer = await readStatementChunk(slices[i], { year });
    // The first slice decides what the document is; later ones only add rows.
    if (i === 0 && answer.documentType !== 'bank_account') {
      documentType = answer.documentType;
      break;
    }
    for (const debit of answer.debits || []) {
      const checked = verifyDebit(debit, lines, statementDate);
      if (!checked) {
        unverified++;
        continue;
      }
      if (!found.has(checked.line)) found.set(checked.line, checked);
    }
  }

  const seenShape = new Map();
  const rows = [...found.values()].sort((a, b) => a.line - b.line).map((d) => {
    const shape = `${d.date}|${d.amount}|${d.description.toLowerCase()}`;
    const occurrence = (seenShape.get(shape) || 0) + 1;
    seenShape.set(shape, occurrence);
    const counterparty = extractCounterparty(d.description);
    return {
      date: d.date,
      amount: d.amount,
      balance: d.balance,
      ref: d.reference,
      raw: d.description,
      counterparty,
      narration: counterparty || d.description.slice(0, 40) || 'Bank debit',
      rail: railFromText(d.description),
      keys: genericKeys(d, occurrence),
      ...(isIgnoredPayee(d.description, ignores) && { isTransfer: true }),
    };
  });

  return { documentType, rows, unverified, verified: [...found.values()] };
}

/** Rows read with a learned layout, in the same shape the model path produces. */
function layoutRows(debits, ignores) {
  return debits.map((d) => {
    const narration = d.narration.slice(0, 200);
    const counterparty = extractCounterparty(narration);
    return {
      date: d.date,
      amount: d.amount,
      balance: d.balance,
      ref: null,
      raw: narration,
      counterparty,
      narration: counterparty || narration.slice(0, 40) || 'Bank debit',
      rail: railFromText(narration),
      keys: genericKeys({ date: d.date, amount: d.amount, balance: d.balance, reference: null, description: narration }),
      ...(isIgnoredPayee(narration, ignores) && { isTransfer: true }),
    };
  });
}

/** Maps a debit row to an expense, applying learned category rules and the transfer rules. */
function toExpense(row, db, bank, holderName = '') {
  const ruled = applyRules({ merchant: row.narration, category: 'General' }, db.categoryRules);
  const reason = row.isTransfer
    ? 'payee'
    : transferReason({ merchant: row.narration, paymentType: row.rail || railOf(row.type), counterparty: row.counterparty }, { holderName });
  return {
    id: newExpenseId(),
    ...(reason && { transfer: true, transferReason: reason }),
    merchant: ruled.merchant,
    amount: row.amount,
    date: row.date,
    category: ruled.category || 'General',
    categorySource: ruled.categorySource || 'statement',
    bank: bank || 'Bank account',
    cardLast4: null,
    paymentType: row.rail || railOf(row.type),
    source: 'statement',
    ref: row.ref || null,
    // Kept so the "move to transfers" action knows what payee to remember.
    counterparty: row.counterparty || null,
    statementRaw: row.raw,
    isExpense: true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Imports account debits from statement emails for the account in context.
 *
 * `passwords` maps each bank's sender address to the password typed for it in
 * this import; `password` is a fallback for all. Neither is stored or logged.
 * `tryPasswords` are further candidates tried in turn, from
 * UPI_STATEMENT_PASSWORD when the owner has chosen to keep one (see
 * checkStatementsAutomatically).
 *
 * Idempotent on two levels: whole statements already read are skipped
 * (processedStatementIds), and any row already imported is skipped
 * (processedUpiRefs) — so the same statement arriving twice still yields one
 * record per transaction. That only holds if runs for one account don't
 * overlap, hence serialisePerUser below.
 */
async function runImport({ afterEpoch, passwords = {}, password = '', tryPasswords = [], dryRun = false, force = false } = {}) {
  const db = await store.init();
  const holderName = ((await users.getUser(requireContextUser().id)) || {}).name || '';
  const seen = new Set(db.processedUpiRefs || []);
  const seenStatements = new Set(db.processedStatementIds || []);

  const ids = await statementMessageIds(afterEpoch);
  // force re-reads statements already marked done. Safe because the row-level
  // keys are the real guard — re-reading a statement re-adds nothing.
  const fresh = dryRun || force ? ids : ids.filter((id) => !seenStatements.has(id));

  const result = {
    statements: ids.length, parsed: 0, added: 0, duplicates: 0, matchedAlerts: 0, ignored: 0,
    skippedStatements: ids.length - fresh.length, skippedCards: 0, skippedOther: 0,
    unreadable: 0, unparsed: 0, unverified: 0, readByModel: 0, readByLayout: 0,
    banks: {},
    // Ids only, so the app can show what was just added for review.
    addedIds: [],
  };
  if (!fresh.length) return result;

  const claimedAlerts = new Set();
  const markRead = async (id) => {
    if (dryRun) return;
    await store.mutate((d) => {
      d.processedStatementIds ||= [];
      if (!d.processedStatementIds.includes(id)) d.processedStatementIds.push(id);
    });
  };

  for (const email of await hydrateStatements(fresh)) {
    const bank = bankLabelForSender(email.from);
    const tally = (result.banks[email.from] ||= { bank, statements: 0, added: 0, duplicates: 0, wrongPassword: false });
    tally.statements++;

    // Each issuer locks its PDF its own way, so every candidate is tried in turn.
    const candidates = [...new Set([passwords[email.from], password, ...tryPasswords].filter(Boolean))];
    if (!candidates.length) candidates.push('');
    let text;
    let failure = null;
    for (const candidate of candidates) {
      try {
        text = await extractStatementText(email.id, candidate);
        failure = null;
        break;
      } catch (err) {
        failure = err;
        if (!err.wrongPassword) break;
      }
    }
    if (failure) {
      logger.error(`Statement ${email.id} could not be opened`, failure.message);
      // A wrong password is not the statement's fault. Leave it unmarked so the
      // next import, with the right password, reads it.
      if (failure.wrongPassword) {
        tally.wrongPassword = true;
        result.wrongPassword = true;
      } else {
        result.error = failure.message;
      }
      continue;
    }

    // A scanned statement is an image with no text to read. Marked read so it
    // isn't downloaded again on every import.
    if (!text.lines.length) {
      result.unreadable++;
      await markRead(email.id);
      continue;
    }

    const kind = classifyStatement(text.lines);
    if (kind === 'credit_card' || kind === 'investment') {
      if (kind === 'credit_card') result.skippedCards++;
      else result.skippedOther++;
      await markRead(email.id);
      continue;
    }

    let rows = parseStatement(text.lines, db.statementIgnores || []).rows;
    // What to record about this bank's learned layout, applied with the rows.
    let layoutChange = null;

    if (!rows.length) {
      const layout = db.statementLayouts?.[email.from];
      const usable = Boolean(layout) && layout.state !== 'retired';
      const byLayout = usable ? parseWithLayout(text.lines, layout.spec) : null;

      if (byLayout?.ok && layoutSkipsModel(layout)) {
        // A proven layout, and every row balanced: no model needed.
        rows = layoutRows(byLayout.debits, db.statementIgnores || []);
        result.readByLayout++;
        layoutChange = { apply: (l) => { l.uses += 1; } };
      } else {
        let read;
        try {
          read = await readWithModel(text.lines, email.date, db.statementIgnores || []);
        } catch (err) {
          // Left unread: a model outage shouldn't lose the statement.
          logger.error(`Statement ${email.id} could not be read by the model`, err.message);
          result.error = err.message;
          continue;
        }
        result.readByModel++;
        result.unverified += read.unverified;
        if (read.documentType !== 'bank_account') {
          if (read.documentType === 'credit_card') result.skippedCards++;
          else result.skippedOther++;
          await markRead(email.id);
          continue;
        }
        rows = read.rows;

        if (usable) {
          // On trial or spot check: the layout must match the model exactly.
          const agreed = Boolean(byLayout?.ok) && sameDebits(byLayout.debits, read.verified);
          layoutChange = { apply: (l) => { l.uses += 1; gradeLayout(l, agreed); } };
        } else {
          const spec = learnLayout(text.lines, read.verified);
          const proof = spec ? parseWithLayout(text.lines, spec) : null;
          if (proof?.ok && sameDebits(proof.debits, read.verified)) {
            layoutChange = {
              learned: { spec, state: 'trial', agree: 1, uses: 0, createdAt: new Date().toISOString() },
            };
          }
        }
      }
    }

    if (config.upi.since) rows = rows.filter((r) => r.date >= config.upi.since);
    result.parsed += rows.length;
    if (!rows.length) {
      result.unparsed++;
      logger.warn(`Statement ${email.id} (${text.lines.length} lines) gave no debit rows`);
    }

    const newExpenses = [];
    const newKeys = [];
    const alertsToMark = [];
    for (const row of rows) {
      if (row.isTransfer) result.ignored++;
      const keys = row.keys || dedupKeys(row);
      if (keys.some((k) => seen.has(k))) {
        result.duplicates++;
        tally.duplicates++;
        continue;
      }
      keys.forEach((k) => seen.add(k));
      newKeys.push(...keys);

      // Already recorded from the bank's own alert email: keep the alert, which
      // has the better merchant name, and remember this row so it isn't
      // re-checked. Transfers too, or they'd be listed twice. A payee you've
      // marked as a transfer marks the alert as one as well.
      const alert = findMatchingAlert(db.expenses, row, claimedAlerts);
      if (alert) {
        claimedAlerts.add(alert.id);
        if (row.isTransfer && !alert.transfer && alert.transferSetBy !== 'you') alertsToMark.push(alert.id);
        result.matchedAlerts++;
        tally.duplicates++;
        continue;
      }

      newExpenses.push(toExpense(row, db, bank, holderName));
    }

    if (!dryRun) {
      await store.mutate((d) => {
        for (const e of d.expenses) {
          if (alertsToMark.includes(e.id)) Object.assign(e, { transfer: true, transferReason: 'payee' });
        }
        if (layoutChange) {
          d.statementLayouts ||= {};
          if (layoutChange.learned) d.statementLayouts[email.from] = layoutChange.learned;
          else if (d.statementLayouts[email.from]) layoutChange.apply(d.statementLayouts[email.from]);
        }
        d.expenses.push(...newExpenses);
        d.processedUpiRefs ||= [];
        d.processedUpiRefs.push(...newKeys);
        d.processedStatementIds ||= [];
        if (!d.processedStatementIds.includes(email.id)) d.processedStatementIds.push(email.id);
      });
    }
    result.added += newExpenses.length;
    tally.added += newExpenses.length;
    result.addedIds.push(...newExpenses.map((e) => e.id));
  }

  logger.info('Statement import complete', { ...result, banks: undefined, error: undefined, addedIds: undefined });
  return result;
}

/** The only way in. See runImport's note on why overlapping runs duplicate. */
export const importUpiStatements = serialisePerUser(runImport);

/**
 * Moves a statement transaction into or out of the transfers set.
 *
 * Marking one as a transfer also remembers its counterparty, so future
 * statements tag that payee on sight. Moving one back to a spend deliberately
 * does NOT forget the payee: paying a bill from the other account is the rare
 * exception, not a signal that every future transfer to that payee is a purchase.
 */
export async function setTransfer(expenseId, transfer) {
  const db = await store.init();
  const expense = db.expenses.find((e) => e.id === expenseId);
  if (!expense) { const e = new Error('No such transaction'); e.status = 404; throw e; }

  // Only a statement row has a payee worth remembering for next time; an alert
  // or a manual spend just changes its own flag.
  let pattern = null;
  if (transfer && expense.source === 'statement') {
    pattern = expense.counterparty || extractCounterparty(expense.statementRaw || expense.merchant || '');
  }

  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === expenseId);
    if (!target) return;
    // Your choice sticks: the automatic transfer rules never undo it.
    target.transferSetBy = 'you';
    if (transfer) {
      target.transfer = true;
      delete target.needsReview;
      delete target.categoryOptions;
      if (pattern) {
        d.statementIgnores ||= [];
        if (!d.statementIgnores.some((p) => p.toLowerCase() === pattern.toLowerCase())) d.statementIgnores.push(pattern);
      }
    } else {
      delete target.transfer;
      delete target.transferReason;
    }
  });

  return { transfer: Boolean(transfer), pattern };
}

/**
 * Reads new statements during the routine poll, the way a personal install
 * does, when there's a password to open them with: ones this person chose to
 * have remembered (saved-passwords.js), or the install's UPI_STATEMENT_PASSWORD.
 * Without either, statements are imported on demand with a password typed each
 * time. Looks back 45 days; statements already read are skipped, so this is
 * cheap when there's nothing new.
 */
export async function checkStatementsAutomatically() {
  const tryPasswords = config.upi.statementPasswords;
  const passwords = await savedPasswords(requireContextUser().id);
  if (!tryPasswords.length && !Object.keys(passwords).length) return null;
  try {
    return await importUpiStatements({ afterEpoch: Math.floor((Date.now() - 45 * 24 * 3600_000) / 1000), passwords, tryPasswords });
  } catch (err) {
    logger.error('Automatic statement import failed', err.message);
    return { error: err.message };
  }
}
