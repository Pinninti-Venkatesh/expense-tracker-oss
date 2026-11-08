import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenAlert, isQuietSender, recordSender, looksLikeSpendSubject } from '../server/gmail/prefilter.js';
import { buildQuery } from '../server/gmail/query.js';
import { bankLabelForSender, bankForSender } from '../server/banks.js';

test('real alerts from different banks pass the free check', () => {
  const alerts = [
    { subject: 'Alert : Update on your HDFC Bank Credit Card', body: 'Rs.642.00 has been debited on your HDFC Bank Credit Card XX4417 towards SWIGGY on 12-09-2026.' },
    { subject: 'Transaction alert for your ICICI Bank Credit Card', body: 'INR 2,352.57 spent on ICICI Bank Card XX0921 on 13-Sep-26 at AMAZON.' },
    { subject: 'You have done a UPI txn', body: 'Dear Customer, ₹193.00 has been debited from account **2210 to VPA bluetokai@okaxis.' },
    { subject: 'Debit alert', body: 'Your A/c XX5521 is debited by 1,250.00 INR on 11/09/2026. Info: POS/DMART.' },
  ];
  for (const alert of alerts) assert.equal(screenAlert(alert).ok, true, alert.subject);
});

test('OTPs, offers and account notices never reach the model', () => {
  assert.deepEqual(screenAlert({ subject: 'OTP for your transaction', body: 'Your OTP is 123456 for a transaction of Rs 500.' }), { ok: false, reason: 'security' });
  assert.deepEqual(screenAlert({ subject: 'Exclusive offer on credit cards', body: 'Get 10% cashback this festive season!' }), { ok: false, reason: 'no_amount' });
  assert.deepEqual(screenAlert({ subject: 'Your balance update', body: 'Available balance INR 45,000.00 as on 31 Aug.' }), { ok: false, reason: 'no_spend_words' });
});

test('a sender goes quiet only after many emails and no spend at all', () => {
  const db = {};
  for (let i = 0; i < 7; i++) recordSender(db, 'offers@shop.in', false);
  assert.equal(isQuietSender(db.senderStats['offers@shop.in']), false);
  recordSender(db, 'offers@shop.in', false);
  assert.equal(isQuietSender(db.senderStats['offers@shop.in']), true);

  recordSender(db, 'offers@shop.in', true);
  assert.equal(isQuietSender(db.senderStats['offers@shop.in']), false);
  assert.equal(isQuietSender(undefined), false);
  assert.equal(looksLikeSpendSubject('Transaction Alert from YES BANK'), true);
});

test('the alert search covers bank domains, alert wording and learned senders', () => {
  const q = buildQuery(1700000000, ['alerts@newbank.co.in', 'alerts@hdfcbank.net']);
  assert.match(q, /from:hdfcbank\.net/);
  assert.match(q, /from:jupiter\.money/);
  assert.match(q, /from:alerts@newbank\.co\.in/);
  assert.doesNotMatch(q, /from:alerts@hdfcbank\.net/); // already covered by its bank's domain
  assert.match(q, /"has been debited"/);
  assert.match(q, /-subject:otp/);
  assert.match(q, /after:1700000000$/);
});

test('statements are labelled with the bank that sent them', () => {
  assert.equal(bankLabelForSender('alerts@hdfcbank.net'), 'HDFC Bank');
  assert.equal(bankLabelForSender('fedmail@federal.bank.in'), 'Federal Bank');
  assert.equal(bankLabelForSender('estatement@mail.axisbank.com'), 'Axis Bank');
  assert.equal(bankLabelForSender('statements@newbank.co.in'), 'newbank.co.in');
  assert.equal(bankForSender('someone@disc.com'), null); // "sc.com" must not match inside another domain
});
