import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

const { parseEnv, quoteEnv, serializeEnv, checks, verifyClaudeKey, consoleUrl, newProjectId } = await import('../scripts/setup.mjs');

test('any password survives the round trip through .env, exactly as typed', () => {
  const tricky = ['simple123', 'has space', 'hash#inside', "it's", 'say "hi"', 'back\\slash', 'both \' and "', 'ends=with=', '₹unicode'];
  const values = Object.fromEntries(tricky.map((v, i) => [`P${i}`, v]));
  const text = serializeEnv(values);

  // What the server will actually read: dotenv, the library config.js uses.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  const read = dotenv.parse(fs.readFileSync(file));
  for (const [k, v] of Object.entries(values)) assert.equal(read[k], v, `${JSON.stringify(v)} came back as ${JSON.stringify(read[k])}`);
  // And the wizard reads its own file back the same way when run again.
  assert.deepEqual(parseEnv(text), values);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plain values are written without quotes; the wizard keeps settings it did not ask about', () => {
  assert.equal(quoteEnv('abc-123.apps.googleusercontent.com'), 'abc-123.apps.googleusercontent.com');
  const text = serializeEnv({ ALLOWED_EMAILS: 'a@x.com,b@y.com', PRODUCT_NAME: 'My Money' });
  assert.match(text, /^ALLOWED_EMAILS=a@x\.com,b@y\.com$/m);
  assert.match(text, /^PRODUCT_NAME='My Money'$/m);
});

test('answers are checked in plain words before they are saved', () => {
  assert.deepEqual(checks.emails('Asha@Gmail.com, dev@gmail.com asha@gmail.com'), { value: 'asha@gmail.com,dev@gmail.com' });
  assert.match(checks.emails('not-an-email').error, /doesn't look like an email/);
  assert.deepEqual(checks.address(''), { error: "That doesn't look like a web address." });
  assert.deepEqual(checks.address('expenses.example.com'), { value: 'https://expenses.example.com' });
  assert.deepEqual(checks.address('http://localhost:8080/'), { value: 'http://localhost:8080' });
  assert.match(checks.address('http://expenses.example.com').error, /https/);
  assert.ok(checks.clientId('123456789012-abcdefghijklmnop.apps.googleusercontent.com').value);
  assert.ok(checks.clientId('GOCSPX-oops').error);
  assert.ok(checks.clientSecret('GOCSPX-abcdefghijklmnopqrstuvwx').value);
  assert.ok(checks.claudeKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz').value);
  assert.match(checks.claudeKey('sk-proj-123').error, /sk-ant-/);
});

test("the Claude key check tells a bad key from an unreachable Anthropic", async () => {
  const answer = (status) => async () => ({ ok: status === 200, status });
  assert.deepEqual(await verifyClaudeKey('k', answer(200)), { ok: true });
  assert.equal((await verifyClaudeKey('k', answer(401))).ok, false);
  assert.equal((await verifyClaudeKey('k', async () => { throw new Error('offline'); })).ok, null, 'offline is not "invalid"');
});

test('console pages open on the project the wizard made, and project ids are valid for Google', () => {
  assert.equal(consoleUrl('auth/clients/create', 'expenses-ab12cd'), 'https://console.cloud.google.com/auth/clients/create?project=expenses-ab12cd');
  assert.equal(consoleUrl('auth/overview'), 'https://console.cloud.google.com/auth/overview');
  // Google: 6–30 characters, lowercase letters, digits and hyphens, starting with a letter.
  for (let i = 0; i < 20; i++) assert.match(newProjectId(), /^[a-z][a-z0-9-]{5,29}$/);
});
