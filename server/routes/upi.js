import express from 'express';
import * as store from '../drive/store.js';
import { savedPasswords, rememberPasswords, forgetPasswords } from '../upi/saved-passwords.js';
import {
  importUpiStatements, setTransfer, findStatementEmails, probeStatement, statementBankLabel,
} from '../upi/statement.js';

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_LOOKBACK_DAYS = 400;

const afterEpochFor = (lookbackDays) => {
  const days = Math.min(Math.max(Number(lookbackDays) || 45, 1), MAX_LOOKBACK_DAYS);
  return Math.floor((Date.now() - days * 24 * 3600_000) / 1000);
};

/**
 * Step one of "Add UPI spends": the statement emails there are to read, grouped
 * by the bank that sent them, with whether each bank's PDFs need a password and
 * the email's own hint about what that password is. Needs no password itself.
 */
router.get('/upi/statements', asyncRoute(async (req, res) => {
  const db = await store.init();
  const read = new Set(db.processedStatementIds || []);
  const emails = await findStatementEmails(afterEpochFor(req.query.lookbackDays));

  const groups = new Map();
  for (const e of emails) {
    const alreadyRead = read.has(e.id);
    // Only statements still to import are checked for a password, which means
    // downloading the PDF; nothing is read from it.
    const state = alreadyRead ? null : await probeStatement(e);
    const group = groups.get(e.from) || {
      key: e.from, bank: statementBankLabel(e.from), needsPassword: false, hint: null, statements: [],
    };
    group.statements.push({
      id: e.id,
      subject: e.subject,
      date: e.date,
      filename: e.attachments[0]?.filename || null,
      alreadyRead,
      locked: state === 'locked',
    });
    if (state === 'locked') group.needsPassword = true;
    group.hint ||= e.hint;
    groups.set(e.from, group);
  }

  // Banks whose password is remembered need nothing typed.
  const saved = await savedPasswords(req.account.id);
  for (const group of groups.values()) group.saved = Boolean(saved[group.key]);

  res.json({ groups: [...groups.values()] });
}));

/**
 * Imports bank-account debits from statement PDFs in the user's Gmail.
 *
 * Passwords come with this request, one per bank (keyed by the sender address
 * from the list above), are used once to open that bank's PDFs, and are dropped,
 * unless the person ticks "remember" (`remember: true`): then they're kept
 * encrypted on their own account for automatic imports (upi/saved-passwords.js).
 * Never logged: statement passwords are usually built from a date of birth or
 * PAN, which is worth more to an attacker than the statement.
 */
router.post('/upi/import', asyncRoute(async (req, res) => {
  const given = req.body?.passwords && typeof req.body.passwords === 'object' ? req.body.passwords : {};
  const passwords = Object.fromEntries(
    Object.entries(given)
      .filter(([key, value]) => typeof value === 'string' && value && key.length <= 320 && value.length <= 200)
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';

  // Remembered passwords open banks left blank this time.
  const saved = await savedPasswords(req.account.id);
  const result = await importUpiStatements({
    afterEpoch: afterEpochFor(req.body?.lookbackDays),
    passwords: { ...saved, ...passwords },
    password,
    force: req.body?.force === true,
  });
  // Only when asked, and only what was typed: "remember for automatic imports".
  // A password that didn't open its bank's statement is never kept.
  const opened = Object.fromEntries(Object.entries(passwords).filter(([key]) => !result.banks?.[key]?.wrongPassword));
  if (req.body?.remember === true && Object.keys(opened).length) {
    await rememberPasswords(req.account.id, opened);
  }
  res.json(result);
}));

/** Which banks' statement passwords this person has remembered (never the passwords). */
router.get('/upi/saved-passwords', asyncRoute(async (req, res) => {
  const saved = await savedPasswords(req.account.id);
  res.json({ banks: Object.keys(saved).map((key) => ({ key, bank: statementBankLabel(key) })) });
}));

router.delete('/upi/saved-passwords', asyncRoute(async (req, res) => {
  await forgetPasswords(req.account.id);
  res.json({ ok: true });
}));

/**
 * Moves a bank-statement transaction into or out of the transfers set.
 *
 * `transfer: true` (the default) also remembers the payee, so future statements
 * tag it on sight; `transfer: false` counts this one as a real spend without
 * forgetting the payee. Nothing is deleted either way.
 */
router.post('/upi/transfer', asyncRoute(async (req, res) => {
  try {
    const wanted = req.body?.transfer !== false;
    const r = await setTransfer(req.body?.id, wanted);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

export default router;
