import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeople, peopleTotals, reminderText } from '../web/src/lib/people.js';
import { setMaskAmounts } from '../web/src/lib/format.js';

const uber = {
  id: 'exp_uber',
  merchant: 'Uber',
  amount: 386,
  date: '2026-09-11',
  split: {
    mode: 'equal',
    yourShare: 193,
    participants: [{ id: 'pp1', name: 'Ravi', owed: 193, status: 'pending' }],
  },
};

const dinner = {
  id: 'exp_toit',
  merchant: 'Toit',
  amount: 1480,
  date: '2026-08-28',
  split: {
    mode: 'equal',
    yourShare: 740,
    participants: [{ id: 'pp2', name: 'ravi', owed: 740, status: 'settled' }],
  },
};

const entry = (over) => ({
  id: 'led_1', direction: 'lent', personName: 'Ravi', amount: 2500, repaid: 500, balance: 2000,
  date: '2026-09-02', note: 'rent', repayments: [], ...over,
});

const ledger = {
  owedToMe: { people: [{ name: 'Ravi', entries: [entry()], settled: [] }] },
  iOwe: {
    people: [
      { name: 'Ravi', entries: [entry({ id: 'led_2', direction: 'borrowed', amount: 300, repaid: 0, balance: 300, note: 'tickets' })], settled: [] },
      { name: 'Meera', entries: [], settled: [entry({ id: 'led_3', personName: 'Meera', direction: 'borrowed', amount: 1200, balance: 0 })] },
    ],
  },
};

test('splits and IOUs for the same name become one person with one balance', () => {
  const people = buildPeople({ expenses: [uber, dinner], ledger });
  const ravi = people.find((p) => p.key === 'ravi');

  assert.equal(ravi.owesYou, 2193); // 193 from the split + 2000 left on the loan
  assert.equal(ravi.youOwe, 300);
  assert.equal(ravi.net, 1893);
  assert.equal(ravi.open.length, 3);
  assert.equal(ravi.settled.length, 1); // the settled dinner split, matched case-insensitively
});

test('fully settled people stay in the list, after everyone with a balance', () => {
  const people = buildPeople({ expenses: [uber], ledger });
  assert.deepEqual(people.map((p) => p.key), ['ravi', 'meera']);
  assert.equal(people[1].net, 0);
  assert.equal(people[1].open.length, 0);
});

test('totals add per-person nets, not raw sides', () => {
  const totals = peopleTotals(buildPeople({ expenses: [uber, dinner], ledger }));
  assert.equal(totals.owedToYou, 1893);
  assert.equal(totals.youOwe, 0);
  assert.equal(totals.owingCount, 1);
});

test('a reminder names what is owed in real rupees, even with amounts hidden', () => {
  setMaskAmounts(true);
  try {
    const ravi = buildPeople({ expenses: [uber], ledger: { owedToMe: ledger.owedToMe } })[0];
    const text = reminderText(ravi);
    assert.match(text, /^Hey Ravi, quick one: /);
    assert.match(text, /₹193 for Uber/);
    assert.match(text, /₹2,000 for rent/);
    assert.match(text, /₹2,193 in all/);
    assert.doesNotMatch(text, /•/);
  } finally {
    setMaskAmounts(false);
  }
});
