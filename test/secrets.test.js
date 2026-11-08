import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { encrypt, decrypt } = await import('../server/users/secrets.js');

test('a token round-trips for the account it was encrypted for', () => {
  const sealed = encrypt('1//refresh-token', 'user-a');
  assert.notEqual(sealed, '1//refresh-token');
  assert.equal(decrypt(sealed, 'user-a'), '1//refresh-token');
});

test('the same token encrypts differently every time', () => {
  assert.notEqual(encrypt('same', 'user-a'), encrypt('same', 'user-a'));
});

test("a token copied onto another account's record does not decrypt", () => {
  const sealed = encrypt('1//refresh-token', 'user-a');
  assert.throws(() => decrypt(sealed, 'user-b'));
});

test('a tampered ciphertext is rejected', () => {
  const [v, iv, tag, body] = encrypt('1//refresh-token', 'user-a').split('.');
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), 'user-a'));
});
