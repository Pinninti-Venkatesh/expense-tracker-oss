/**
 * End to end, as a self-hosted install: every optional feature off (the
 * default), and sign-in limited to a household allowlist. Same real server and
 * fakes as app.e2e.test.js, which covers the paid-service configuration.
 *
 *   npm run test:e2e
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, client, signIn, firstSync } from './setup.js';

const app = await startApp({
  port: 18190,
  hosted: false,
  env: {
    ALLOWED_EMAILS: 'asha.rao@gmail.com, Vikram.Mehta@gmail.com',
    // Two accounts would be enough to publish a shared format, so an empty
    // library below is down to sharing being off, not to the threshold.
    TEMPLATE_LIBRARY_MIN_ACCOUNTS: '2',
  },
});
const { base, fakes, files } = app;
const { PERSONAS, buildInbox, deliverMail, hdfcAlert, ledgerOf, time } = fakes;
const users = await import('../server/users/store.js');
const { DAY, MIN } = time;

after(() => app.cleanup());

const CRON = { headers: { 'X-Cron-Key': 'e2e-cron-secret' } };
const inboxes = { asha: buildInbox('asha'), vikram: buildInbox('vikram') };
const browsers = {};
const emailSpends = async (browser) => (await browser.get('/api/expenses')).json.expenses.filter((e) => e.source === 'email');

test('a visitor sees no trial, no payments and no policy pages, and the page loads nothing third-party', async () => {
  const visitor = client(base);
  const home = await visitor.get('/');
  assert.equal(home.status, 200);
  const csp = home.headers.get('content-security-policy');
  assert.doesNotMatch(csp, /razorpay/, 'no payment provider is allowed to load');
  assert.match(csp, /frame-src 'none'/);

  const session = (await visitor.get('/api/session')).json;
  assert.deepEqual(session.features, { billing: false, legalPages: false, sharedTemplates: false });
  assert.equal('trialDays' in session, false);

  for (const page of ['/privacy', '/terms']) {
    const res = await visitor.get(page);
    assert.doesNotMatch(res.text, /Razorpay|\[SET /, `${page} is the app shell, not a policy`);
  }
  assert.notEqual((await visitor.post('/api/billing/webhook', { event: 'subscription.charged' })).status, 200);
});

test('only allowlisted Google accounts can sign in, whatever the case of their address', async () => {
  const asha = await signIn(base, 'asha');
  assert.equal(asha.done.status, 302);
  browsers.asha = asha.browser;

  const vikram = await signIn(base, 'vikram');
  assert.equal(vikram.done.status, 302, 'the allowlist is matched case-insensitively');
  browsers.vikram = vikram.browser;

  const stranger = await signIn(base, 'nisha');
  assert.equal(stranger.done.status, 403);
  assert.match(stranger.done.text, /Not on the list/);
  assert.equal(await users.getUser(PERSONAS.nisha.sub), null, 'no account is created for someone not on the list');
});

test('an account has no trial or plan, and no policy consent is recorded', async () => {
  const me = (await browsers.asha.get('/api/me')).json;
  assert.equal(me.billing, null);
  assert.equal(me.trialDaysLeft, null);
  assert.equal((await browsers.asha.get('/api/billing')).status, 404);

  const account = await users.getUser(PERSONAS.asha.sub);
  assert.ok(account.createdAt);
  assert.equal(account.consentVersion, undefined);
});

test('bank formats are learned per account and never shared, even when two accounts learn the same one', async () => {
  for (const key of ['asha', 'vikram']) {
    const batches = await firstSync(browsers[key]);
    assert.equal(batches.at(-1).done, true, JSON.stringify(batches.at(-1)));
    assert.equal((await emailSpends(browsers[key])).length, inboxes[key].expectedSpends);

    const templates = ledgerOf(key).alertTemplates['alerts@hdfcbank.net'];
    assert.ok(templates.some((t) => t.state === 'live'), `${key} learned the format`);
    assert.ok(templates.every((t) => !t.offeredAt), `${key}'s format was not offered for sharing`);
  }
  assert.equal(fs.existsSync(files.library), false, 'no shared library is ever written');
});

test('an account months old is never locked, and the scheduled poll reads every account', async () => {
  await users.saveUser(PERSONAS.asha.sub, { createdAt: new Date(Date.now() - 90 * DAY).toISOString() });
  const b = browsers.asha;
  for (const route of ['/api/expenses', '/api/me', '/api/loans']) {
    assert.equal((await b.get(route)).status, 200, `${route} stays open`);
  }

  const late = deliverMail('asha', hdfcAlert('asha', { amount: 777, merchant: 'SWIGGY BANGALORE IN', at: Date.now() - 3 * MIN }));
  const run = await client(base).post('/api/cron/poll', {}, CRON);
  assert.equal(run.status, 200);
  assert.equal(run.json.accounts, 2);
  assert.equal(run.json.unpaid, 0);
  assert.ok(ledgerOf('asha').processedEmailIds.includes(late.id), 'the old account is still read');
});
