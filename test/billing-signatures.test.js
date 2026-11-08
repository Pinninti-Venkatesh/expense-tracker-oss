import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../server/billing/signatures.js';

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

test('a checkout signature over payment id | subscription id verifies', () => {
  const signature = hmac('key_secret', 'pay_29QQoUBi66xm2f|sub_00000000000001');
  assert.equal(verifyCheckoutSignature({ paymentId: 'pay_29QQoUBi66xm2f', subscriptionId: 'sub_00000000000001', signature }, 'key_secret'), true);
});

test('a checkout signature for another subscription, secret or payment is refused', () => {
  const signature = hmac('key_secret', 'pay_1|sub_mine');
  assert.equal(verifyCheckoutSignature({ paymentId: 'pay_1', subscriptionId: 'sub_someone_else', signature }, 'key_secret'), false);
  assert.equal(verifyCheckoutSignature({ paymentId: 'pay_2', subscriptionId: 'sub_mine', signature }, 'key_secret'), false);
  assert.equal(verifyCheckoutSignature({ paymentId: 'pay_1', subscriptionId: 'sub_mine', signature }, 'other_secret'), false);
});

test('missing pieces never verify, including an unset secret', () => {
  const signature = hmac('', 'pay_1|sub_1');
  assert.equal(verifyCheckoutSignature({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature }, ''), false);
  assert.equal(verifyCheckoutSignature({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature: '' }, 'key_secret'), false);
  assert.equal(verifyWebhookSignature('{}', hmac('', '{}'), ''), false);
  assert.equal(verifyWebhookSignature(null, 'abc', 'whsec'), false);
});

test('a webhook signature is checked against the raw bytes, not re-serialised JSON', () => {
  const raw = Buffer.from('{"event":"subscription.charged","payload":{"amount":9900.0}}');
  const signature = hmac('whsec', raw);
  assert.equal(verifyWebhookSignature(raw, signature, 'whsec'), true);

  // Parsing and stringifying turns 9900.0 into 9900, which changes the bytes.
  const reserialised = JSON.stringify(JSON.parse(raw.toString()));
  assert.equal(verifyWebhookSignature(reserialised, signature, 'whsec'), false);
});

test('a signature of the wrong length is refused without throwing', () => {
  assert.equal(verifyWebhookSignature('{}', 'short', 'whsec'), false);
  assert.equal(verifyCheckoutSignature({ paymentId: 'p', subscriptionId: 's', signature: 'x'.repeat(200) }, 'k'), false);
});
