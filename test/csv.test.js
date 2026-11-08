import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expensesToCsv, csvCell } from '../server/csv.js';

test('cells with commas, quotes or line breaks are quoted', () => {
  assert.equal(csvCell('Chai, samosa'), '"Chai, samosa"');
  assert.equal(csvCell('The "good" one'), '"The ""good"" one"');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(450), '450');
});

test('text that a spreadsheet would run as a formula is opened as text', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+91 call'), "'+91 call");
  assert.equal(csvCell(-12), '-12'); // real numbers stay numbers
});

test('export lists newest first with your cost after splits and refunds', () => {
  const csv = expensesToCsv([
    { date: '2026-09-01', merchant: 'Zepto', amount: 841, category: 'Groceries', source: 'email' },
    {
      date: '2026-09-11',
      merchant: 'Uber',
      amount: 386,
      category: 'Travel',
      source: 'email',
      split: { yourShare: 193, participants: [{ name: 'Ravi', owed: 193, status: 'pending' }] },
    },
    { date: '2026-09-05', merchant: 'Myntra', amount: 2598, refunds: [{ amount: 1299 }], source: 'email' },
  ]);

  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'date');
  assert.match(lines[1], /^2026-09-11,Uber,386,193,Travel/);
  assert.match(lines[1], /,193,,,$/); // owed_to_you then empty refunded, note, description
  assert.match(lines[2], /^2026-09-05,Myntra,2598,1299,/);
  assert.match(lines[3], /^2026-09-01,Zepto,841,841,Groceries/);
});
