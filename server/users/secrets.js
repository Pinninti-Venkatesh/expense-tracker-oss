import crypto from 'node:crypto';
import config from '../config.js';

/**
 * Encryption for the one valuable thing the server holds: each user's Google
 * refresh token, which can read their mail and their ledger file.
 *
 * AES-256-GCM with a random IV per value. The user id is bound in as associated
 * data, so a ciphertext copied onto another user's record fails to decrypt
 * instead of quietly granting access to the wrong mailbox.
 */
const VERSION = 'v1';

function key() {
  const raw = Buffer.from(config.security.tokenEncryptionKey || '', 'base64');
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
  return raw;
}

export function encrypt(plaintext, boundTo) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(String(boundTo)));
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decrypt(value, boundTo) {
  const [version, iv, tag, body] = String(value || '').split('.');
  if (version !== VERSION || !iv || !tag || !body) throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(String(boundTo)));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
