/**
 * End to end, as the simplest self-hosted install: Gmail read over IMAP with an
 * app password (MAIL_ACCESS=app-password), no Google Cloud project, ledgers on
 * this machine. Same real server as the other runs; imapflow is faked from the
 * same inboxes the Gmail API fake serves.
 *
 *   npm run test:e2e
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startApp, client, firstSync } from './setup.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-data-'));
const ledgerDir = path.join(dataDir, 'ledgers');
const app = await startApp({
  port: 18290,
  hosted: false,
  env: {
    MAIL_ACCESS: 'app-password',
    // A fresh install: no Google Cloud project, no household list, no Claude
    // key. Everything comes from the first-run screen.
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    ALLOWED_EMAILS: '',
    ANTHROPIC_API_KEY: '',
    // Made by the install itself, in the data folder.
    SESSION_SECRET: '',
    TOKEN_ENCRYPTION_KEY: '',
    CRON_SECRET: '',
    DATA_DIR: dataDir,
  },
});
const { base, fakes } = app;
const { PERSONAS, appPasswordOf, buildInbox, deliverMail, hdfcAlert, state, time } = fakes;
const users = await import('../server/users/store.js');
const install = await import('../server/install.js');
const { appPasswordAccountId } = await import('../server/routes/auth.js');
const store = await import('../server/drive/store.js');
const { runAsUser } = await import('../server/context.js');

after(() => {
  app.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const config = (await import('../server/config.js')).default;
const CRON = { headers: { 'X-Cron-Key': config.cron.secret } };
const GOOD_KEY = 'sk-ant-api03-good-e2e-key-0123456789';
const inbox = buildInbox('asha');
const asha = client(base);
const vikram = client(base);
const ashaId = appPasswordAccountId(PERSONAS.asha.email);
const vikramId = appPasswordAccountId(PERSONAS.vikram.email);
const grouped = (pw) => pw.match(/.{4}/g).join(' ');
const connect = (browser, body) => browser.post('/api/login/app-password', body);
const creds = (key, extra = {}) => ({ email: PERSONAS[key].email, appPassword: appPasswordOf(key), ...extra });
const readLedger = () => JSON.parse(fs.readFileSync(path.join(ledgerDir, `${ashaId}.json`), 'utf8'));
let inviteToken;

test('a fresh install asks for its first-run screen, and nobody can sign in before it is set up', async () => {
  const visitor = client(base);
  const session = (await visitor.get('/api/session')).json;
  assert.equal(session.mailAccess, 'app-password');
  assert.deepEqual(session.setup, { needed: true, needsKey: true });

  for (const intent of ['signin', 'reconnect', 'pin-reset']) {
    const res = await visitor.get(`/api/login?intent=${intent}`);
    assert.equal(res.headers.get('location'), `/signin?intent=${intent}`, 'stays on the app, never goes to Google');
  }
  const early = await connect(visitor, creds('asha'));
  assert.equal(early.status, 409);
  assert.match(early.json.error, /isn't set up yet/);
  assert.equal(state.imapLogins, 0, 'nothing reached Gmail');

  // The install made its own secrets: nothing to generate or paste.
  const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
  assert.ok(secrets.SESSION_SECRET && secrets.TOKEN_ENCRYPTION_KEY && secrets.CRON_SECRET);
  assert.equal(fs.statSync(path.join(dataDir, 'secrets.json')).mode & 0o777, 0o600);
});

test('the setup code and the Claude key are checked before anything is saved', async () => {
  const visitor = client(base);
  const wrong = await visitor.post('/api/setup/check', { code: '0000-0000' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.field, 'code');

  const code = install.setupCode();
  assert.match(code, /^\d{4}-\d{4}$/);
  assert.equal((await visitor.post('/api/setup/check', { code: code.replace('-', ' ') })).status, 200, 'spaces and dashes don\'t matter');

  const badKey = await visitor.post('/api/setup/check', { code, apiKey: 'sk-ant-api03-revoked-key-0123456789' });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.json.field, 'apiKey');
  assert.match(badKey.json.error, /not valid/);
  assert.equal((await visitor.post('/api/setup/check', { code, apiKey: 'not-a-key' })).json.field, 'apiKey');
  assert.equal((await visitor.post('/api/setup/check', { code, apiKey: GOOD_KEY })).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false, 'checking saves nothing');
});

test('finishing setup makes the first person the owner, keeps the key encrypted and retires the code', async () => {
  const code = install.setupCode();
  const res = await asha.post('/api/setup/claim', { code, apiKey: GOOD_KEY, ...creds('asha', { appPassword: grouped(appPasswordOf('asha')), name: 'Asha Rao' }) });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const account = await users.getUser(ashaId);
  assert.equal(account.role, 'owner');
  assert.equal(account.name, 'Asha Rao');
  assert.ok(account.encryptedAppPassword);
  const settingsText = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
  assert.equal(settingsText.includes(GOOD_KEY), false, 'the Claude key is stored encrypted');
  assert.equal(JSON.parse(settingsText).ownerId, ashaId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')).setupCode, undefined, 'the code works once');
  const usersText = fs.readFileSync(process.env.USER_STORE_FILE, 'utf8');
  assert.equal(usersText.includes(appPasswordOf('asha')), false, 'the app password is never stored in the clear');

  assert.deepEqual((await client(base).get('/api/session')).json.setup, { needed: false, needsKey: false });
  assert.equal((await client(base).post('/api/setup/claim', { code, apiKey: GOOD_KEY, ...creds('vikram') })).status, 409, 'nobody can claim it twice');
  assert.equal((await asha.get('/api/me')).status, 200);
});

test('people join only through an invite link, which works once', async () => {
  const stranger = await connect(client(base), creds('nisha'));
  assert.equal(stranger.status, 403);
  assert.match(stranger.json.error, /invited/);

  const made = await asha.post('/api/household/invites');
  assert.equal(made.status, 201);
  inviteToken = made.json.path.split('/').pop();
  const preview = (await client(base).get(`/api/invites/${inviteToken}`)).json;
  assert.deepEqual(preview, { valid: true, from: 'Asha', product: 'Expenses' });

  const joined = await connect(vikram, creds('vikram', { invite: inviteToken }));
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.equal((await vikram.get('/api/me')).status, 200);

  const reused = await connect(client(base), creds('nisha', { invite: inviteToken }));
  assert.equal(reused.status, 400);
  assert.match(reused.json.error, /expired or was already used/);
  assert.deepEqual((await client(base).get(`/api/invites/${inviteToken}`)).json, { valid: false });

  const household = (await asha.get('/api/household')).json;
  assert.deepEqual(household.members.map((m) => [m.email, m.owner, m.you]), [
    [PERSONAS.asha.email, true, true], [PERSONAS.vikram.email, false, false],
  ]);
  assert.equal(household.claude.key, 'sk-ant-…6789');
  assert.equal(household.claude.changeable, true);

  assert.equal((await vikram.post('/api/household/invites')).status, 403, 'only the owner invites');
  assert.equal((await vikram.get('/api/household')).json.invites.length, 0);
});

test('the owner can change the Claude key, but only to one that works', async () => {
  const rejected = await asha.put('/api/household/claude-key', { apiKey: 'sk-ant-api03-revoked-key-0123456789' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error, /not valid/);
  assert.equal((await vikram.put('/api/household/claude-key', { apiKey: GOOD_KEY })).status, 403);

  const changed = await asha.put('/api/household/claude-key', { apiKey: 'sk-ant-api03-good-second-key-abcd' });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.key, 'sk-ant-…abcd');
});

test('removing someone ends their access at once, and only a new invite lets them back', async () => {
  assert.equal((await vikram.del(`/api/household/members/${ashaId}`)).status, 403, 'only the owner removes people');
  assert.equal((await asha.del(`/api/household/members/${ashaId}`)).status, 400, 'the owner can\'t remove themselves');

  assert.equal((await asha.del(`/api/household/members/${vikramId}`)).status, 200);
  assert.equal((await vikram.get('/api/expenses')).status, 401);
  const again = await connect(client(base), creds('vikram'));
  assert.equal(again.status, 403);
  assert.match(again.json.error, /access to this app was removed/);
  assert.deepEqual((await asha.get('/api/household')).json.members.map((m) => m.email), [PERSONAS.asha.email]);
});

test('the first sync reads the inbox over IMAP, and the ledger is a private file on this machine', async () => {
  const batches = await firstSync(asha);
  assert.equal(batches.at(-1).done, true, JSON.stringify(batches.at(-1)));
  const spends = (await asha.get('/api/expenses')).json.expenses.filter((e) => e.source === 'email');
  assert.equal(spends.length, inbox.expectedSpends, 'same answer as the Gmail API path: OTP, promo, duplicate and out-of-window skipped');

  const file = path.join(ledgerDir, `${ashaId}.json`);
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(ledger.expenses.filter((e) => e.source === 'email').length, inbox.expectedSpends);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only the app can read it');
  assert.equal((await asha.get('/api/me')).json.driveFileUrl, null, 'no Drive link is offered');
  assert.equal(state.drives.size, 0, 'Google Drive is never touched');
});

test('a server that was off for days reads everything it missed, not just the last day', async () => {
  // The app was last able to check three days ago (a sleeping laptop, say).
  await runAsUser({ id: ashaId, email: PERSONAS.asha.email }, () => store.mutate((d) => {
    d.meta.lastPollAt = new Date(Date.now() - 3 * time.DAY).toISOString();
  }));
  const missed = deliverMail('asha', hdfcAlert('asha', { amount: 4321, merchant: 'ZEPTO MARKETPLACE PVT', at: Date.now() - 2 * time.DAY }));

  const run = await client(base).post('/api/cron/poll', {}, CRON);
  assert.equal(run.json.ok, 1, JSON.stringify(run.json));
  const ledger = readLedger();
  assert.ok(ledger.processedEmailIds.includes(Buffer.from(missed.id).toString('hex')), 'an alert from two days ago is read');
  assert.ok(ledger.expenses.some((e) => e.amount === 4321));
  assert.ok(Date.now() - Date.parse(ledger.meta.lastPollAt) < time.MIN, 'the next poll starts from here');
});

test('a big backlog is read in batches, and "Check now" says how much is left', async () => {
  for (let i = 0; i < 65; i++) {
    deliverMail('asha', hdfcAlert('asha', { amount: 100 + i, merchant: 'UBER INDIA SYSTEMS', at: Date.now() - (70 - i) * time.MIN }));
  }
  const first = await asha.post('/api/sync');
  assert.equal(first.json.added, 60, JSON.stringify(first.json));
  assert.equal(first.json.remaining, 5, 'the app asks again until this is zero');
  const second = await asha.post('/api/sync');
  assert.equal(second.json.added, 5);
  assert.equal(second.json.remaining, 0);
});

test('the scheduled poll reads new mail, and a removed app password pauses the account until it reconnects', async () => {
  const late = deliverMail('asha', hdfcAlert('asha', { amount: 777, merchant: 'SWIGGY BANGALORE IN', at: Date.now() - 3 * time.MIN }));
  const run = await client(base).post('/api/cron/poll', {}, CRON);
  assert.equal(run.json.ok, 1, JSON.stringify(run.json));
  const ledgerFile = () => JSON.parse(fs.readFileSync(path.join(ledgerDir, `${ashaId}.json`), 'utf8'));
  assert.ok(ledgerFile().processedEmailIds.includes(Buffer.from(late.id).toString('hex')), 'ids are the Gmail API\'s, from X-GM-MSGID');

  state.removedAppPasswords.add('asha');
  const paused = await client(base).post('/api/cron/poll', {}, CRON);
  assert.equal(paused.json.needsReauth, 1, JSON.stringify(paused.json));
  assert.equal((await users.getUser(ashaId)).needsReauth, true);
  const blocked = await asha.get('/api/expenses');
  assert.equal(blocked.status, 401);
  assert.match(blocked.json.error, /Gmail access needs to be reconnected/);
  assert.match(blocked.json.loginUrl, /intent=reconnect/);

  // A new app password, as Google would make after the old one was removed.
  state.removedAppPasswords.delete('asha');
  const back = await connect(asha, { email: PERSONAS.asha.email, appPassword: appPasswordOf('asha'), intent: 'reconnect' });
  assert.equal(back.status, 200);
  assert.equal((await users.getUser(ashaId)).needsReauth, false);
  assert.equal(ledgerFile().meta.firstSyncAt, null, 'the first sync runs again to catch up on the gap');
  assert.equal((await asha.get('/api/expenses')).status, 200);
});

test('a PIN reset by signing in again marks the session as freshly proven', async () => {
  const res = await connect(asha, { email: PERSONAS.asha.email, appPassword: appPasswordOf('asha'), intent: 'pin-reset' });
  assert.equal(res.json.redirect, '/?pinReset=1');
});

test('repeated wrong guesses are cut off before they reach Gmail', async () => {
  const guesser = client(base);
  let last;
  for (let i = 0; i < 10; i++) last = await connect(guesser, { email: PERSONAS.asha.email, appPassword: 'wrongwrongwrongw' });
  assert.equal(last.status, 429);
  assert.match(last.json.error, /Too many tries/);
});

test('the owner can download the whole install as one encrypted backup', async () => {
  const short = await asha.post('/api/household/backup', { passphrase: 'short' });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /at least 8/);

  const res = await asha.post('/api/household/backup', { passphrase: 'correct horse battery' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="expenses-backup-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(res.text.includes(PERSONAS.asha.email), false, 'nothing readable without the passphrase');
  assert.equal(res.text.includes('UBER'), false);

  const { openBackup } = await import('../server/backup.js');
  await assert.rejects(openBackup(res.text, 'wrong passphrase'), /doesn't open this backup/);
  const opened = await openBackup(res.text, 'correct horse battery');
  assert.ok(opened.files[`ledgers/${ashaId}.json`], 'every ledger is in it');
  assert.ok(opened.files['users.json'].includes(PERSONAS.asha.email));
  assert.equal(opened.secrets.TOKEN_ENCRYPTION_KEY, config.security.tokenEncryptionKey, 'with the key that reads the saved app passwords');
});

