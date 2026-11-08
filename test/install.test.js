import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
Object.assign(process.env, {
  DATA_DIR: dir,
  MAIL_ACCESS: 'app-password',
  USER_STORE: 'file',
  USER_STORE_FILE: path.join(dir, 'users.json'),
  ALLOWED_EMAILS: '',
  ANTHROPIC_API_KEY: '',
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
});
delete process.env.SETUP_CODE;

const { default: config } = await import('../server/config.js');
const install = await import('../server/install.js');
const users = await import('../server/users/store.js');
const saved = await import('../server/upi/saved-passwords.js');

beforeEach(() => {
  config.users.allowlist = [];
});

test('a fresh install needs setup; one that lists its household in ALLOWED_EMAILS does not', async () => {
  install.load();
  assert.equal(await install.setupNeeded(), true);
  assert.equal(install.needsClaudeKey(), true);
  config.users.allowlist = ['asha@gmail.com'];
  assert.equal(await install.setupNeeded(), false, 'the first of them to sign in becomes the owner');
});

test('the setup code is 8 digits, stays the same across restarts, and is checked in constant time', () => {
  const code = install.setupCode();
  assert.match(code, /^\d{4}-\d{4}$/);
  assert.equal(install.setupCode(), code, 'the same code after a restart, so the printed one keeps working');
  assert.equal(install.checkSetupCode(code.replace('-', '')), true);
  assert.equal(install.checkSetupCode(` ${code} `), true);
  assert.equal(install.checkSetupCode('1234-567'), false);
  assert.equal(install.checkSetupCode(''), false);
});

test('finishing setup records the owner, keeps the key encrypted, and retires the code', async () => {
  await users.saveUser('owner-1', { email: 'asha@gmail.com', status: 'active', createdAt: '2026-10-01T00:00:00Z' });
  install.completeSetup({ ownerId: 'owner-1', anthropicKey: 'sk-ant-api03-secret-key-for-tests' });
  assert.equal(await install.setupNeeded(), false);
  assert.equal(await install.ownerId(), 'owner-1');
  assert.equal(config.ai.anthropic.apiKey, 'sk-ant-api03-secret-key-for-tests');
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('secret-key-for-tests'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).setupCode, undefined);
  assert.equal(install.claudeKeyHint(), 'sk-ant-…ests');

  // After a restart the key is read back from settings.json.
  config.ai.anthropic.apiKey = '';
  install.load();
  assert.equal(config.ai.anthropic.apiKey, 'sk-ant-api03-secret-key-for-tests');
});

test('an invite works once, keeps only a hash of its token, and can be cancelled', () => {
  const made = install.createInvite('owner-1');
  assert.ok(made.token.length >= 20);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes(made.token), false);
  const found = install.findInvite(made.token);
  assert.equal(found.id, made.id);
  assert.equal(install.findInvite('nope'), null);

  install.useInvite(found.id, 'member-1');
  assert.equal(install.findInvite(made.token), null, 'used');
  assert.deepEqual(install.listInvites(), []);

  const second = install.createInvite('owner-1');
  assert.equal(install.listInvites().length, 1);
  install.cancelInvite(second.id);
  assert.equal(install.findInvite(second.token), null, 'cancelled');
});

test('an invite stops working after seven days', (t) => {
  const made = install.createInvite('owner-1');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 24 * 3600_000 });
  assert.equal(install.findInvite(made.token), null);
  t.mock.timers.reset();
});

test('remembered statement passwords are encrypted per person, merged per bank, and forgotten on request', async () => {
  await users.saveUser('member-2', { email: 'dev@gmail.com', status: 'active' });
  await saved.rememberPasswords('member-2', { 'alerts@hdfcbank.net': 'DEV1990' });
  await saved.rememberPasswords('member-2', { 'fedmail@federal.bank.in': 'dev@2024' });
  assert.deepEqual(await saved.savedPasswords('member-2'), { 'alerts@hdfcbank.net': 'DEV1990', 'fedmail@federal.bank.in': 'dev@2024' });
  assert.equal(fs.readFileSync(process.env.USER_STORE_FILE, 'utf8').includes('DEV1990'), false, 'never in the clear');
  assert.deepEqual(await saved.savedPasswords('owner-1'), {}, "nobody else's");

  await saved.forgetPasswords('member-2');
  assert.deepEqual(await saved.savedPasswords('member-2'), {});
});

test('an install from before owners existed makes its earliest account the owner', async () => {
  fs.rmSync(path.join(dir, 'settings.json'));
  install.load();
  await users.saveUser('later', { email: 'b@gmail.com', status: 'active', createdAt: '2026-10-03T00:00:00Z' });
  assert.equal(await install.ownerId(), 'owner-1');
  assert.equal(await install.isOwner('later'), false);
});
