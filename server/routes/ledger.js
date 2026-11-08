import express from 'express';
import logger from '../utils/logger.js';
import * as store from '../drive/store.js';
import {
  DIRECTIONS, buildEntry, buildRepayment, validateRepayment, repaidTotal, summarise,
} from '../ledger.js';

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function requireEntry(db, id) {
  const entry = (db.ledger?.entries || []).find((e) => e.id === id);
  if (!entry) {
    const err = new Error('No such ledger entry');
    err.status = 404;
    throw err;
  }
  return entry;
}

/**
 * Resolves a person from an id or a name, creating one if the name is new — the
 * same people list splits use, so a person is shared across both features.
 * Must run inside store.mutate so a newly created person is persisted.
 */
function resolvePerson(d, { personId, personName }) {
  d.people ||= [];
  if (personId) {
    const found = d.people.find((p) => p.id === personId);
    if (found) return found;
  }
  const name = String(personName || '').trim();
  if (!name) {
    const err = new Error('personId or personName is required');
    err.status = 400;
    throw err;
  }
  const existing = d.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;

  const person = {
    id: `per_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    email: null,
  };
  d.people.push(person);
  return person;
}

// --- the tab's data -------------------------------------------------------

router.get('/ledger', asyncRoute(async (req, res) => {
  const db = await store.init();
  res.json({ people: db.people || [], ...summarise(db.ledger?.entries || []) });
}));

// --- entries --------------------------------------------------------------

router.post('/ledger', asyncRoute(async (req, res) => {
  const { direction, personId, personName, amount, date, note } = req.body || {};

  if (!DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: `direction must be one of: ${DIRECTIONS.join(', ')}` });
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  let entry;
  try {
    await store.mutate((d) => {
      d.ledger ||= { entries: [] };
      const person = resolvePerson(d, { personId, personName });
      entry = buildEntry({ direction, person, amount: numericAmount, date, note });
      d.ledger.entries.push(entry);
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  logger.info(`Ledger: ${entry.direction} ${entry.amount} ${entry.direction === 'lent' ? 'to' : 'from'} ${entry.personName}`);
  res.status(201).json(entry);
}));

/** Edit an entry's amount, date, note, direction, or the person it's against. */
router.patch('/ledger/:id', asyncRoute(async (req, res) => {
  const { amount, date, note, direction, personId, personName } = req.body || {};

  if (direction !== undefined && !DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: `direction must be one of: ${DIRECTIONS.join(', ')}` });
  }
  if (date !== undefined && date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  let numericAmount;
  if (amount !== undefined) {
    numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
  }

  let updated;
  try {
    await store.mutate((d) => {
      const entry = requireEntry(d, req.params.id);

      // An amount can't drop below what's already been repaid — that would make
      // the balance negative and the repayment history nonsensical.
      if (numericAmount !== undefined) {
        const repaid = repaidTotal(entry);
        if (numericAmount + 0.005 < repaid) {
          const err = new Error(`Amount can't be less than ${repaid.toFixed(2)} already repaid`);
          err.status = 400;
          throw err;
        }
        entry.amount = round(numericAmount);
      }
      if (date !== undefined) entry.date = date || entry.date;
      if (note !== undefined) entry.note = note ? String(note).slice(0, 200) : null;
      if (direction !== undefined) entry.direction = direction;
      if (personId !== undefined || personName !== undefined) {
        const person = resolvePerson(d, { personId, personName });
        entry.personId = person.id;
        entry.personName = person.name;
      }
      entry.updatedAt = new Date().toISOString();
      updated = entry;
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  res.json({ ok: true, entry: updated });
}));

router.delete('/ledger/:id', asyncRoute(async (req, res) => {
  let removed = false;
  await store.mutate((d) => {
    const list = d.ledger?.entries || [];
    const i = list.findIndex((e) => e.id === req.params.id);
    if (i !== -1) { list.splice(i, 1); removed = true; }
  });

  if (!removed) return res.status(404).json({ error: 'No such ledger entry' });
  res.json({ ok: true });
}));

// --- repayments -----------------------------------------------------------

router.post('/ledger/:id/repayments', asyncRoute(async (req, res) => {
  const db = await store.init();
  const entry = requireEntry(db, req.params.id);

  let amount;
  try {
    amount = validateRepayment(entry, req.body?.amount);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const repayment = buildRepayment({ amount, date: req.body?.date, note: req.body?.note });

  await store.mutate((d) => {
    const target = requireEntry(d, req.params.id);
    target.repayments ||= [];
    target.repayments.push(repayment);
    target.updatedAt = new Date().toISOString();
  });

  res.status(201).json({ ok: true, repayment });
}));

router.delete('/ledger/:id/repayments/:repaymentId', asyncRoute(async (req, res) => {
  let removed = false;
  await store.mutate((d) => {
    const target = requireEntry(d, req.params.id);
    const list = target.repayments || [];
    const i = list.findIndex((r) => r.id === req.params.repaymentId);
    if (i !== -1) { list.splice(i, 1); removed = true; target.updatedAt = new Date().toISOString(); }
  });

  if (!removed) return res.status(404).json({ error: 'No such repayment' });
  res.json({ ok: true });
}));

export default router;
