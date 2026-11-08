import crypto from 'node:crypto';

/**
 * Razorpay's two signatures. Both are HMAC-SHA256, as lowercase hex.
 *
 *   checkout  hmac(key_secret, `${payment_id}|${subscription_id}`)
 *             handed to the browser after the customer authorises a subscription.
 *             The subscription id must be the one this server created and stored
 *             for the account, never the one the browser sends back.
 *
 *   webhook   hmac(webhook_secret, raw request body), in X-Razorpay-Signature.
 *             Checked against the exact bytes received: parsing and re-serialising
 *             the JSON can reorder keys or reformat numbers, and then nothing matches.
 */
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time, so a signature can't be guessed byte by byte from response timing. */
function sameSignature(given, expected) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyCheckoutSignature({ paymentId, subscriptionId, signature }, keySecret) {
  if (!keySecret || !paymentId || !subscriptionId || !signature) return false;
  return sameSignature(signature, hmacHex(keySecret, `${paymentId}|${subscriptionId}`));
}

export function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!webhookSecret || !signature || rawBody == null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return sameSignature(signature, hmacHex(webhookSecret, body));
}
