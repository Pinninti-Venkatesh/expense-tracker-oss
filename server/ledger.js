/**
 * Personal IOUs — money lent to and borrowed from people, tracked by hand.
 *
 * Deliberately separate from splits and from expenses. A split
 * answers "how do we divide this one bill"; this answers "I handed Ravi ₹2,000,
 * how much of it is still outstanding". These are never credit-card
 * transactions, so every entry is manual.
 *
 * One list holds both sides; `direction` distinguishes them:
 *   lent     — they owe you.
 *   borrowed — you owe them.
 *
 * Repayments are a list, not a single number, because a debt is often paid back
 * in instalments and each lands on its own date (same shape as refunds). The
 * outstanding balance is amount minus what's been paid back.
 */
import { today } from './utils/datetime.js';

export const DIRECTIONS = ['lent', 'borrowed'];

export function newEntryId() {
  return `led_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function newRepaymentId() {
  return `rep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Total paid back against one entry. */
export const repaidTotal = (entry) =>
  round((entry.repayments || []).reduce((s, r) => s + (Number(r.amount) || 0), 0));

/** Still outstanding on one entry — never negative. */
export const entryBalance = (entry) =>
  Math.max(0, round((Number(entry.amount) || 0) - repaidTotal(entry)));

/** Settled means fully paid back, not that it never happened. */
export const isSettled = (entry) => entryBalance(entry) <= 0.005;

/**
 * Validates a repayment against what's already been paid back, so instalments
 * can accumulate but never exceed the original amount. Returns the rounded value.
 */
export function validateRepayment(entry, amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error('Repayment amount must be a positive number');
    err.status = 400;
    throw err;
  }
  const remaining = entryBalance(entry);
  if (value > remaining + 0.005) {
    const err = new Error(
      `That repays ${value.toFixed(2)} against a ${remaining.toFixed(2)} balance` +
        (repaidTotal(entry) > 0 ? ` (${repaidTotal(entry).toFixed(2)} already repaid)` : ''),
    );
    err.status = 400;
    throw err;
  }
  return round(value);
}

export function buildRepayment({ amount, date, note }) {
  return {
    id: newRepaymentId(),
    amount,
    date: date || today(),
    note: note ? String(note).slice(0, 200) : null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Builds a ledger entry. `person` is a resolved people-list record, so its name
 * is denormalised onto the entry for display without a lookup.
 */
export function buildEntry({ direction, person, amount, date, note }) {
  if (!DIRECTIONS.includes(direction)) {
    const err = new Error(`direction must be one of: ${DIRECTIONS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return {
    id: newEntryId(),
    direction,
    personId: person.id,
    personName: person.name,
    amount: round(amount),
    date: date || today(),
    note: note ? String(note).slice(0, 200) : null,
    repayments: [],
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
}

/** Adds the computed balance and settled flag to an entry for the client. */
function view(entry) {
  const balance = entryBalance(entry);
  return { ...entry, repaid: repaidTotal(entry), balance, settled: balance <= 0.005 };
}

/**
 * Groups outstanding entries by person for one direction. Only people with a
 * live balance appear; fully-settled entries are counted so the UI can offer to
 * reveal them, but they don't clutter the open list.
 */
function groupByPerson(entries, direction) {
  const byPerson = new Map();

  for (const raw of entries.filter((e) => e.direction === direction)) {
    const e = view(raw);
    const row = byPerson.get(e.personId) || {
      personId: e.personId,
      name: e.personName,
      balance: 0,
      entries: [],
      settled: [],
    };
    if (e.settled) row.settled.push(e);
    else {
      row.balance = round(row.balance + e.balance);
      row.entries.push(e);
    }
    byPerson.set(e.personId, row);
  }

  const people = [...byPerson.values()]
    .map((p) => ({
      ...p,
      entries: p.entries.sort((a, b) => (a.date < b.date ? 1 : -1)),
      settled: p.settled.sort((a, b) => (a.date < b.date ? 1 : -1)),
      settledCount: p.settled.length,
    }))
    // People whose every entry is settled stay in the list, so the People tab
    // can show them as settled instead of letting them vanish.
    .filter((p) => p.balance > 0.005 || p.entries.length > 0 || p.settled.length > 0)
    .sort((a, b) => b.balance - a.balance);

  return { total: round(people.reduce((s, p) => s + p.balance, 0)), people };
}

/**
 * The whole Debts tab in one payload: what's owed to you, what you owe, and the
 * net position per person (so someone on both sides shows a single number).
 */
export function summarise(entries = []) {
  const owedToMe = groupByPerson(entries, 'lent');
  const iOwe = groupByPerson(entries, 'borrowed');

  const net = new Map();
  const add = (personId, name, delta) => {
    const row = net.get(personId) || { personId, name, net: 0 };
    row.net = round(row.net + delta);
    net.set(personId, row);
  };
  for (const p of owedToMe.people) add(p.personId, p.name, p.balance);
  for (const p of iOwe.people) add(p.personId, p.name, -p.balance);

  return {
    owedToMe,
    iOwe,
    netTotal: round(owedToMe.total - iOwe.total),
    net: [...net.values()]
      .filter((p) => Math.abs(p.net) >= 0.01)
      .sort((a, b) => b.net - a.net),
  };
}
