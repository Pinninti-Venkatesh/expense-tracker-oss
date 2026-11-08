import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');

const { isOwnName, transferReason } = await import('../server/transfers.js');
const { findDuplicateNotification, applyTransferRules, TRANSFER_RULES_VERSION } = await import('../server/poll.js');

const HOLDER = 'Asha Rao';

test("a payment to the account holder's own name is theirs, however the bank writes it", () => {
  for (const payee of ['MR ASHA RAO', 'Rao Asha', 'ASHA RAO', 'Ms. Asha K Rao', 'rao, asha']) {
    assert.equal(isOwnName(payee, HOLDER), true, payee);
  }
});

test('a first name alone, or a business with the name in it, is someone else', () => {
  for (const payee of ['Asha', 'Asha Traders', 'Rao Enterprises', 'Asha Rao Clinic', 'Asha Reddy']) {
    assert.equal(isOwnName(payee, HOLDER), false, payee);
  }
  assert.equal(isOwnName('MR ASHA RAO', 'Asha'), false, 'a one-word profile name is too common to match on');
  assert.equal(isOwnName('MR ASHA RAO', ''), false);
});

test('money to your own name, into a savings pot, or out by net banking is a transfer; a card spend is not', () => {
  const ctx = { holderName: HOLDER, sender: 'alerts@jupiter.money' };
  assert.equal(transferReason({ merchant: 'MR ASHA RAO', paymentType: 'UPI' }, ctx), 'own-account');
  assert.equal(transferReason({ merchant: 'Jupiter Pot', paymentType: 'UPI' }, ctx), 'own-account');
  assert.equal(transferReason({ merchant: 'Savings Pot', paymentType: 'UPI' }, ctx), 'own-account');
  assert.equal(transferReason({ merchant: '<UNKNOWN>', paymentType: 'Net Banking' }, { holderName: HOLDER, sender: 'cbsalerts.sbi@alerts.sbi.bank.in' }), 'bank-transfer');
  assert.equal(transferReason({ merchant: 'Zepto', paymentType: 'Credit Card' }, { holderName: HOLDER, sender: 'alerts@hdfcbank.net' }), null);
  assert.equal(transferReason({ merchant: 'Ashok Kumar', paymentType: 'UPI' }, ctx), null, 'paying another person by UPI is still spending');
  assert.equal(transferReason({ merchant: 'Hot Pot Kitchen', paymentType: 'Credit Card' }, ctx), null, 'a restaurant named "pot" is a purchase');
});

test("a merchant's receipt says net banking, but it's still a purchase", () => {
  assert.equal(transferReason({ merchant: 'Electricity board', paymentType: 'Net Banking' }, { holderName: HOLDER, sender: 'no-reply@razorpay.com' }), null);
});

const at = (iso) => new Date(iso).toISOString();
const alert = (over) => ({ id: `e${Math.random()}`, source: 'email', amount: 3400, at: at('2026-09-23T10:00:00Z'), ...over });

test("a payment gateway's receipt and the bank's alert for one charge are one spend, whatever the merchant names", () => {
  const bank = alert({ merchant: 'UPI NET Distribution S', sender: 'alerts@yes.bank.in' });
  const receipt = alert({ merchant: 'Net Distribution Servi', sender: 'no-reply@razorpay.com', at: at('2026-09-23T10:03:00Z') });
  assert.equal(findDuplicateNotification([bank], receipt), bank);
  assert.equal(findDuplicateNotification([receipt], bank), receipt);
});

test('two different spends of the same amount from one bank are both kept', () => {
  const first = alert({ merchant: 'Zepto', sender: 'alerts@hdfcbank.net' });
  const second = alert({ merchant: 'Swiggy', sender: 'alerts@hdfcbank.net', at: at('2026-09-23T10:02:00Z') });
  assert.equal(findDuplicateNotification([first], second), undefined);
});

test('the transfer rules correct an existing ledger once, keep your own choices, and drop receipts that duplicate a bank alert', () => {
  const d = {
    meta: {},
    expenses: [
      alert({ id: 'self', merchant: 'MR ASHA RAO', sender: 'alerts@jupiter.money', paymentType: 'UPI', amount: 5000, needsReview: true }),
      alert({ id: 'kept', merchant: 'MR ASHA RAO', sender: 'alerts@jupiter.money', paymentType: 'UPI', amount: 700, transferSetBy: 'you' }),
      alert({ id: 'shop', merchant: 'Zepto', sender: 'alerts@hdfcbank.net', paymentType: 'Credit Card', amount: 450 }),
      alert({ id: 'bank', merchant: 'UPI NET Distribution S', sender: 'alerts@yes.bank.in', paymentType: 'Credit Card' }),
      alert({ id: 'receipt', merchant: 'Net Distribution Servi', sender: 'no-reply@razorpay.com', paymentType: 'UPI', at: at('2026-09-23T11:00:00Z') }),
      { id: 'manual', source: 'manual', merchant: 'MR ASHA RAO', amount: 100 },
    ],
  };
  const outcome = applyTransferRules(d, HOLDER);
  const byId = Object.fromEntries(d.expenses.map((e) => [e.id, e]));
  assert.deepEqual(outcome, { marked: 1, receiptsRemoved: 1 });
  assert.equal(byId.self.transfer, true);
  assert.equal(byId.self.needsReview, undefined, 'a transfer never asks for a category');
  assert.equal(byId.kept.transfer, undefined, 'your own "count as spend" choice stands');
  assert.equal(byId.shop.transfer, undefined);
  assert.equal(byId.manual.transfer, undefined, 'manual entries are yours to classify');
  assert.ok(byId.bank && !byId.receipt, "the bank's alert is kept, the receipt dropped");
  assert.equal(d.meta.transferRules, TRANSFER_RULES_VERSION);
});
