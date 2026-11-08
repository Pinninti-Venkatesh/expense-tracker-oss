import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStatement, transactionRegion, overlappingChunks, amountAppears, verifyDebit, railFromText,
  genericKeys, findMatchingAlert, passwordHint,
} from '../server/upi/generic.js';

const LINES = [
  'Customer Name: Asha Kumar',
  'Account No: 50100123456789',
  'Date Narration Chq/Ref No Withdrawal Amt Deposit Amt Closing Balance',
  '01/08/26 UPI-SWIGGY-swiggy@ybl-422312345678 422312345678 320.00 9,680.00',
  'Branch: MG Road',
  '02/08/26 NEFT CR-ACME PAYROLL 50,000.00 59,680.00',
  '03/08/26 POS 4417XXXX DMART 1,500.00 58,180.00',
];

test('statements are told apart by what is printed in them', () => {
  assert.equal(classifyStatement(['Total Amount Due 12,345.00', 'Minimum Amount Due 620.00']), 'credit_card');
  assert.equal(classifyStatement(['Folio No 1234567', 'NAV 45.21']), 'investment');
  assert.equal(classifyStatement(['Opening Balance 10,000.00', ...LINES]), 'bank_account');
  assert.equal(classifyStatement(['Thank you for banking with us']), 'unknown');
});

test('the model sees the table, not the name, account number or branch', () => {
  const region = transactionRegion(LINES);
  assert.deepEqual(region.map((r) => r.index), [2, 3, 5, 6]);
  assert.equal(region.some((r) => /Asha|50100123456789|Branch/.test(r.text)), false);
});

test('slices overlap so a wrapped row is never cut in half', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ index: i, text: `row ${i}` }));
  const chunks = overlappingChunks(rows, 120, 4);
  assert.deepEqual(chunks.map((c) => [c[0].index, c[c.length - 1].index]), [[0, 119], [116, 235], [232, 249]]);
});

test('an amount counts only when that exact figure is printed', () => {
  assert.equal(amountAppears(1500, '1,500.00'), true);
  assert.equal(amountAppears(500, '1,500.00'), false);
  assert.equal(amountAppears(500, 'paid 500.50'), false);
  assert.equal(amountAppears(500.5, 'paid 500.50'), true);
});

test('a debit the model reports is kept only when the statement backs it up', () => {
  const good = { line: 3, date: '2026-08-01', amount: 320, description: 'UPI-SWIGGY-swiggy@ybl', reference: '422312345678', balance: 9680 };
  assert.deepEqual(verifyDebit(good, LINES, '2026-09-02'), {
    line: 3, date: '2026-08-01', amount: 320, description: 'UPI-SWIGGY-swiggy@ybl', reference: '422312345678', balance: 9680,
  });
  assert.equal(verifyDebit({ ...good, amount: 999 }, LINES, '2026-09-02'), null); // not printed
  assert.equal(verifyDebit({ ...good, line: 99 }, LINES, '2026-09-02'), null); // no such line
  assert.equal(verifyDebit({ ...good, date: '2027-01-01' }, LINES, '2026-09-02'), null); // after the statement
  assert.equal(verifyDebit({ ...good, date: '01/08/2026' }, LINES, '2026-09-02'), null); // not a date we asked for
});

test('the rail is read from the narration', () => {
  assert.equal(railFromText('UPI-SWIGGY-swiggy@ybl'), 'UPI');
  assert.equal(railFromText('NEFT DR-HDFC0000123'), 'NEFT');
  assert.equal(railFromText('ATM WDL MG ROAD'), 'ATM');
  assert.equal(railFromText('POS 4417XXXX DMART'), 'Debit Card');
  assert.equal(railFromText('SMS CHARGES QTR'), 'Charge');
  assert.equal(railFromText('TO SELF'), 'Bank');
});

test('identical rows without a reference or balance are still two transactions', () => {
  const coffee = { date: '2026-08-05', amount: 50, description: 'Blue Tokai', reference: null, balance: null };
  assert.notDeepEqual(genericKeys(coffee, 1), genericKeys(coffee, 2));
  assert.deepEqual(genericKeys({ ...coffee, reference: 'R1', balance: 900 }, 1), ['ref:R1|2026-08-05|50', 'bal:2026-08-05|50|900']);
});

test('a statement row matches the bank alert already recorded for it, once', () => {
  const expenses = [
    { id: 'card', source: 'email', paymentType: 'Credit Card', amount: 320, date: '2026-08-01' },
    { id: 'upi', source: 'email', paymentType: 'UPI', amount: 320, date: '2026-08-02' },
    { id: 'old', source: 'email', paymentType: 'UPI', amount: 320, date: '2026-07-20' },
  ];
  const row = { date: '2026-08-01', amount: 320 };
  const claimed = new Set();
  const match = findMatchingAlert(expenses, row, claimed);
  assert.equal(match.id, 'upi'); // card charges never touch the bank account; July is too far
  claimed.add(match.id);
  assert.equal(findMatchingAlert(expenses, row, claimed), null);
});

test('the password hint is the sentence that explains the format', () => {
  const body = 'Never share your password with anyone. Your statement is password protected: use the first four letters of your name in capitals followed by your date of birth in DDMM format. Happy banking!';
  assert.match(passwordHint(body), /^Your statement is password protected: use the first four letters/);
  assert.equal(passwordHint('Please find your statement attached. Never share your password.'), null);
});
