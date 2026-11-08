/**
 * Moving an install: a backup made elsewhere, restored onto a brand-new
 * app-password install from its first-run screen. Everyone's saved Gmail access
 * works straight away, because the backup carries the key that decrypts it.
 *
 *   npm run test:e2e
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, client } from './setup.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-restore-'));
const app = await startApp({
  port: 18390,
  hosted: false,
  env: {
    MAIL_ACCESS: 'app-password',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    ALLOWED_EMAILS: '',
    ANTHROPIC_API_KEY: '',
    SESSION_SECRET: '',
    TOKEN_ENCRYPTION_KEY: '',
    CRON_SECRET: '',
    DATA_DIR: dataDir,
  },
});
const { base, fakes } = app;
const { PERSONAS, appPasswordOf, buildInbox } = fakes;
const config = (await import('../server/config.js')).default;
const install = await import('../server/install.js');
const { sealBackup } = await import('../server/backup.js');
const { encrypt } = await import('../server/users/secrets.js');
const { appPasswordAccountId } = await import('../server/routes/auth.js');

after(() => {
  app.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PASSPHRASE = 'moving house in october';
const ashaId = appPasswordAccountId(PERSONAS.asha.email);
buildInbox('asha');

/** A backup as another install would have made it, with its own keys. */
async function backupFromElsewhere() {
  const secrets = {
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    CRON_SECRET: crypto.randomBytes(32).toString('hex'),
  };
  // Encrypted the way that install did, with its key, not this one's.
  const ours = config.security.tokenEncryptionKey;
  config.security.tokenEncryptionKey = secrets.TOKEN_ENCRYPTION_KEY;
  const encryptedAppPassword = encrypt(appPasswordOf('asha'), ashaId);
  const anthropicKey = encrypt('sk-ant-api03-good-restored-key-wxyz', 'install');
  config.security.tokenEncryptionKey = ours;

  const ledger = {
    version: 1,
    expenses: [{ id: 'e1', amount: 1234, merchant: 'From the old computer', category: 'Food', date: '2026-09-20', source: 'manual', isExpense: true }],
    processedEmailIds: [],
    knownSenders: [],
    meta: { firstSyncAt: '2026-09-01T00:00:00.000Z', lastPollAt: new Date().toISOString() },
  };
  return sealBackup({
    createdAt: new Date().toISOString(),
    product: 'Expenses',
    secrets,
    files: {
      'users.json': JSON.stringify({
        [ashaId]: { id: ashaId, email: PERSONAS.asha.email, name: 'Asha Rao', status: 'active', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z', encryptedAppPassword },
      }),
      'settings.json': JSON.stringify({ ownerId: ashaId, setupAt: '2026-09-01T00:00:00.000Z', anthropicKey, invites: [] }),
      [`ledgers/${ashaId}.json`]: JSON.stringify(ledger),
      // A path that tries to climb out of the data folder is never written.
      '../escape.json': '{"bad":true}',
    },
  }, PASSPHRASE);
}

const restore = (body, { code = install.setupCode(), passphrase = PASSPHRASE } = {}) => fetch(`${base}/api/setup/restore`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Setup-Code': code, 'X-Backup-Passphrase': passphrase },
  body,
}).then(async (r) => ({ status: r.status, json: await r.json() }));

test('a wrong setup code, a wrong passphrase or a file that isn\'t a backup are refused, and nothing is written', async () => {
  const file = await backupFromElsewhere();
  assert.equal((await restore(file, { code: '0000-0000' })).json.field, 'code');
  const wrong = await restore(file, { passphrase: 'not the passphrase' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /passphrase doesn't open/);
  const junk = await restore('{"hello":"world"}');
  assert.match(junk.json.error, /isn't a backup/);
  assert.equal(fs.existsSync(path.join(dataDir, 'users.json')), false);
  assert.equal((await client(base).get('/api/session')).json.setup.needed, true);
});

test('restoring brings back every account, ledger and setting, and their saved Gmail access works at once', async () => {
  const res = await restore(await backupFromElsewhere());
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.accounts, 1);
  assert.equal(res.json.ledgers, 1);
  assert.equal(fs.existsSync(path.join(dataDir, '..', 'escape.json')), false);

  const session = (await client(base).get('/api/session')).json;
  assert.deepEqual(session.setup, { needed: false, needsKey: false }, 'set up, with the Claude key from the backup');
  assert.equal(config.ai.anthropic.apiKey, 'sk-ant-api03-good-restored-key-wxyz');

  // The restored app password decrypts with the restored key: the scheduled
  // poll reads Asha's Gmail before she has even signed in again.
  const run = await client(base).post('/api/cron/poll', {}, { headers: { 'X-Cron-Key': config.cron.secret } });
  assert.equal(run.json.ok, 1, JSON.stringify(run.json));

  const asha = client(base);
  const signIn = await asha.post('/api/login/app-password', { email: PERSONAS.asha.email, appPassword: appPasswordOf('asha') });
  assert.equal(signIn.status, 200, 'a member signs in again, no invite needed');
  const expenses = (await asha.get('/api/expenses')).json.expenses;
  assert.ok(expenses.some((e) => e.merchant === 'From the old computer'), 'the old ledger is here');
  assert.equal((await asha.get('/api/household')).json.isOwner, true);

  assert.equal((await restore(await backupFromElsewhere())).status, 409, 'never onto an install that is set up');
});
