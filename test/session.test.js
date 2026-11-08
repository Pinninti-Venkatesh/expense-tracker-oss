import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { issue, verify } = await import('../server/auth/session.js');

test('a session issued for an account verifies to that account', () => {
  const claims = verify(issue({ uid: 'acct-1', email: 'a@example.com' }));
  assert.equal(claims.uid, 'acct-1');
  assert.equal(claims.email, 'a@example.com');
});

test('changing the account id inside a session breaks its signature', () => {
  const [, sig] = issue({ uid: 'acct-1' }).split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'acct-2', exp: Date.now() + 60_000 })).toString('base64url');
  assert.equal(verify(`${forged}.${sig}`), null);
});

test('malformed and expired sessions are rejected', () => {
  assert.equal(verify(undefined), null);
  assert.equal(verify('not-a-token'), null);

  const payload = Buffer.from(JSON.stringify({ uid: 'acct-1', exp: Date.now() - 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  assert.equal(verify(`${payload}.${sig}`), null);
});
