import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readDate, trailingMoney, learnLayout, parseWithLayout, sameDebits, gradeLayout, layoutSkipsModel,
  LAYOUT_TRIAL_STATEMENTS, LAYOUT_SPOT_CHECK_EVERY,
} from '../server/templates/layouts.js';

const LINES = [
  'Statement of Account',
  'Opening Balance 10,000.00',
  'Date Narration Withdrawal Deposit Balance',
  '01/08/2026 UPI/swiggy@ybl/422312345678 320.00 9,680.00',
  '02/08/2026 NEFT/ACME PAYROLL 50,000.00 59,680.00',
  '03/08/2026 POS 4417XXXX DMART 1,500.00 58,180.00',
  '04/08/2026 UPI/zepto@axl/422398765432 841.00 57,339.00',
  'ZEPTO MARKETPLACE',
  '05/08/2026 ATM WDL MG ROAD 2,000.00 55,339.00',
  '06/08/2026 SMS CHARGES 17.70 55,321.30 Cr',
  'Closing Balance 55,321.30',
];

// What the model read and generic.js verified for this statement.
const VERIFIED = [
  { line: 3, date: '2026-08-01', amount: 320, balance: 9680 },
  { line: 5, date: '2026-08-03', amount: 1500, balance: 58180 },
  { line: 6, date: '2026-08-04', amount: 841, balance: 57339 },
  { line: 8, date: '2026-08-05', amount: 2000, balance: 55339 },
  { line: 9, date: '2026-08-06', amount: 17.7, balance: 55321.3 },
];

test('dates are read in each format, and impossible dates are refused', () => {
  assert.equal(readDate('01/08/2026 UPI', 'dmy_slash'), '2026-08-01');
  assert.equal(readDate('01-Aug-26 NEFT', 'dmy_mon'), '2026-08-01');
  assert.equal(readDate('2026-08-01 ATM', 'ymd'), '2026-08-01');
  assert.equal(readDate('31/02/2026 UPI', 'dmy_slash'), null);
  assert.deepEqual(trailingMoney('06/08/2026 SMS CHARGES 17.70 55,321.30Cr'), { money: [17.7, 55321.3], rest: '06/08/2026 SMS CHARGES' });
});

test('a layout learned from verified rows reads the statement, proven row by row', () => {
  const spec = learnLayout(LINES, VERIFIED);
  assert.deepEqual(spec, { format: 'dmy_slash', balanceFromEnd: 0 });

  const read = parseWithLayout(LINES, spec);
  assert.equal(read.ok, true);
  assert.equal(read.credits, 1); // the salary is recognised as money in, from the balance going up
  assert.equal(read.unresolved, 0);
  assert.equal(sameDebits(read.debits, VERIFIED), true);
  assert.equal(read.debits.find((d) => d.amount === 841).narration, 'UPI/zepto@axl/422398765432 ZEPTO MARKETPLACE');
});

test('a statement that stops balancing is not trusted', () => {
  const spec = learnLayout(LINES, VERIFIED);
  const tampered = LINES.map((l, i) => (i === 6 ? '04/08/2026 UPI/zepto@axl/422398765432 841.00 57,000.00' : l));
  assert.equal(parseWithLayout(tampered, spec).ok, false);

  const noOpening = LINES.filter((l) => !/Opening Balance/.test(l));
  assert.equal(parseWithLayout(noOpening, spec).ok, false); // the first row can't be proven
});

test('too few verified rows teach nothing', () => {
  assert.equal(learnLayout(LINES, VERIFIED.slice(0, 3)), null);
  assert.equal(learnLayout(LINES, VERIFIED.map((r) => ({ ...r, balance: null }))), null);
});

test('a layout goes live after agreeing twice, is spot-checked, and retires on a disagreement', () => {
  const layout = { state: 'trial', agree: 1, uses: 0 };
  assert.equal(LAYOUT_TRIAL_STATEMENTS, 2);
  assert.equal(layoutSkipsModel(layout), false);
  assert.equal(gradeLayout(layout, true), 'live');
  assert.equal(layoutSkipsModel(layout), true);
  assert.equal(layoutSkipsModel({ ...layout, uses: LAYOUT_SPOT_CHECK_EVERY - 1 }), false);
  assert.equal(gradeLayout(layout, false), 'retired');
  assert.equal(layoutSkipsModel(layout), false);
  assert.equal(sameDebits([{ date: '2026-08-01', amount: 320 }], [{ date: '2026-08-01', amount: 321 }]), false);
});
