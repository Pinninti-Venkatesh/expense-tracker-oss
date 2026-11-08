import express from 'express';
import logger from '../utils/logger.js';
import * as store from '../drive/store.js';
import { computeSplit, setParticipantStatus, SPLIT_MODES } from '../splits.js';

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const newPersonId = () => `per_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const round = (n) => Math.round(n * 100) / 100;

function findExpense(db, id) {
  const expense = db.expenses.find((e) => e.id === id);
  if (!expense) {
    const err = new Error('No such expense');
    err.status = 404;
    throw err;
  }
  return expense;
}

// --- people you split with ------------------------------------------------

router.get('/people', asyncRoute(async (req, res) => {
  const db = await store.init();
  res.json({ people: db.people || [] });
}));

router.post('/people', asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const person = { id: newPersonId(), name, email: req.body?.email || null };

  await store.mutate((d) => {
    d.people ||= [];
    if (!d.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) d.people.push(person);
  });

  res.status(201).json(person);
}));

router.delete('/people/:id', asyncRoute(async (req, res) => {
  const db = await store.init();
  const person = (db.people || []).find((p) => p.id === req.params.id);
  if (!person) return res.status(404).json({ error: 'No such person' });

  // Refuse rather than orphan references. Ledger entries point at the person id;
  // splits carry the name on each participant.
  const inLedger = (db.ledger?.entries || []).filter((e) => e.personId === req.params.id).length;
  const inSplits = db.expenses.filter((e) =>
    e.split?.participants?.some((p) => p.name.toLowerCase() === person.name.toLowerCase())).length;
  if (inLedger || inSplits) {
    return res.status(409).json({
      error: `${person.name} is still referenced by ${inLedger} debt${inLedger === 1 ? '' : 's'} and ` +
        `${inSplits} split${inSplits === 1 ? '' : 's'}. Remove those first.`,
    });
  }

  let removed = false;
  await store.mutate((d) => {
    const i = (d.people || []).findIndex((p) => p.id === req.params.id);
    if (i !== -1) { d.people.splice(i, 1); removed = true; }
  });

  if (!removed) return res.status(404).json({ error: 'No such person' });
  res.json({ ok: true });
}));

// --- splitting a transaction ---------------------------------------------

router.post('/expenses/:id/split', asyncRoute(async (req, res) => {
  const { mode, participants, includeYou = true } = req.body || {};

  if (!SPLIT_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${SPLIT_MODES.join(', ')}` });
  }
  if (!Array.isArray(participants) || !participants.length) {
    return res.status(400).json({ error: 'Add at least one person to split with' });
  }
  if (participants.some((p) => !String(p.name || '').trim())) {
    return res.status(400).json({ error: 'Every participant needs a name' });
  }

  const db = await store.init();
  const expense = findExpense(db, req.params.id);

  let split;
  try {
    split = computeSplit({ total: expense.amount, mode, participants, includeYou });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  split.createdAt = new Date().toISOString();

  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === expense.id);
    target.split = split;

    // Remember new names so the picker fills in next time.
    d.people ||= [];
    for (const p of split.participants) {
      if (!d.people.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) {
        d.people.push({ id: newPersonId(), name: p.name, email: null });
      }
    }
  });

  res.json({ ok: true, split });
}));

router.delete('/expenses/:id/split', asyncRoute(async (req, res) => {
  const db = await store.init();
  findExpense(db, req.params.id);

  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === req.params.id);
    delete target.split;
  });

  res.json({ ok: true });
}));

/** Mark one person settled up, waived off, or back to owing. */
router.post('/expenses/:id/split/:participantId/status', asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  const db = await store.init();
  findExpense(db, req.params.id);

  let updated;
  try {
    await store.mutate((d) => {
      const target = d.expenses.find((e) => e.id === req.params.id);
      updated = setParticipantStatus(target, req.params.participantId, status);
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  logger.info(`Split participant marked ${status} on ${req.params.id}`);
  res.json({ ok: true, participant: updated });
}));

/**
 * What people still owe you from split transactions, per person. A split is
 * always money you paid, so every balance here is owed to you; settling happens
 * on the transaction itself.
 */
router.get('/balances', asyncRoute(async (req, res) => {
  const db = await store.init();
  const byPerson = new Map();

  for (const e of db.expenses) {
    for (const p of e.split?.participants || []) {
      if (p.status !== 'pending') continue;
      const key = p.name.toLowerCase();
      const row = byPerson.get(key) || { key, name: p.name, net: 0 };
      row.net += Number(p.owed) || 0;
      byPerson.set(key, row);
    }
  }

  const people = [...byPerson.values()]
    .map((p) => ({ ...p, net: round(p.net) }))
    .filter((p) => p.net >= 0.01)
    .sort((a, b) => b.net - a.net);

  res.json({ people, owedToYou: round(people.reduce((s, p) => s + p.net, 0)) });
}));

export default router;
