/**
 * End to end: the real server, real routes, stores, learning and billing, with
 * fakes only where the app meets the outside world (fakes.js). Scenarios run in
 * order and build on each other, like one afternoon of five people using it.
 *
 * This file runs the app as a public paid service, with every optional feature
 * on. selfhost.e2e.test.js covers the default self-hosted install.
 *
 *   npm run test:e2e
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, client, signIn, firstSync } from './setup.js';

const app = await startApp({ port: 18090, hosted: true });
const { base, fakes, files } = app;
const {
  state, PERSONAS, buildInbox, deliverMail, hdfcAlert, iciciAlert, ledgerOf,
  razorpay, webhookEvent, deliverWebhook, checkoutResponse, time,
} = fakes;
const users = await import('../server/users/store.js');
const { startOfPreviousMonth, localDate } = await import('../server/utils/datetime.js');
const { DAY, MIN, unix } = time;

after(() => app.cleanup());

const CRON = { headers: { 'X-Cron-Key': 'e2e-cron-secret' } };
const inboxes = {};
for (const key of ['asha', 'vikram', 'meera', 'dev']) inboxes[key] = buildInbox(key);
// Nisha banks with ICICI, a layout nobody else here has.
inboxes.nisha = buildInbox('nisha', { alert: iciciAlert });

const browsers = {};
const modelCalls = {};
let meeraMissed = null;
let meeraSub = null;

const library = () => {
  try {
    return Object.values(JSON.parse(fs.readFileSync(files.library, 'utf8')));
  } catch {
    return [];
  }
};
const emailSpends = async (browser) => (await browser.get('/api/expenses')).json.expenses.filter((e) => e.source === 'email');

/* ---------- arriving ---------- */

test('a signed-out visitor gets the app shell, its manifest and the legal pages, but no data', async () => {
  const visitor = client(base);
  const home = await visitor.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<link rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self' https:\/\/checkout\.razorpay\.com/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');

  const manifest = await visitor.get('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.display, 'standalone');
  for (const icon of manifest.json.icons) {
    const res = await fetch(base + icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), 'image/png');
  }

  // The screens are told which model provider is in use, so their copy follows
  // the server rather than a hardcoded vendor name.
  const provider = process.env.E2E_AI_PROVIDER || 'anthropic';
  const onBedrock = provider === 'bedrock';
  assert.deepEqual((await visitor.get('/api/session')).json, {
    signedIn: false,
    product: 'Expenses',
    features: { billing: true, legalPages: true, sharedTemplates: true },
    trialDays: 14,
    googleVerified: false,
    mailAccess: 'google',
    // Google sign-in installs are configured in .env, never on a first-run screen.
    setup: { needed: false, needsKey: false },
    ai: onBedrock
      ? { label: 'Claude on Amazon Bedrock', retention: "It isn't stored or used to train models." }
      : { label: 'Claude at Anthropic', retention: "It isn't used to train models." },
  });
  assert.equal((await visitor.get('/api/expenses')).status, 401);
  assert.equal((await visitor.get('/api/billing')).status, 401);

  const privacy = await visitor.get('/privacy');
  assert.match(privacy.text, /Razorpay/);
  assert.match(privacy.text, /at least 3 accounts/);
  assert.doesNotMatch(privacy.text, /\{\{/);
  // The policy names the provider the server actually calls, and only that one.
  assert.match(privacy.text, onBedrock ? /Amazon Bedrock/ : /<strong>Anthropic<\/strong>/);
  assert.doesNotMatch(privacy.text, onBedrock ? /<strong>Anthropic<\/strong>/ : /Amazon Bedrock/);
  const terms = await visitor.get('/terms');
  assert.match(terms.text, /free for 14 days/);
  assert.match(terms.text, /\[SET REFUND POLICY\]/);
});

test('signing up with Google creates the account with its token encrypted; a partial grant is refused', async () => {
  const { browser, start, done } = await signIn(base, 'asha');
  assert.equal(start.status, 302);
  assert.ok(start.headers.get('location').startsWith(state.googleBase));
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/');
  assert.ok(browser.jar.has('et_session'));
  browsers.asha = browser;

  assert.equal((await browser.get('/api/session')).json.signedIn, true);
  const account = await users.getUser('g-asha');
  assert.equal(account.email, 'asha.rao@gmail.com');
  assert.ok(account.encryptedRefreshToken);
  assert.doesNotMatch(fs.readFileSync(files.users, 'utf8'), /rt:asha/, 'the refresh token is never stored in the clear');

  const partial = await signIn(base, 'ravi');
  assert.equal(partial.done.status, 403);
  assert.match(partial.done.text, /Access was not granted/);
  assert.equal(await users.getUser('g-ravi'), null);
});

test('a new account starts a 14-day trial and sees the trial intro once, priced from Razorpay', async () => {
  const b = browsers.asha;
  const me = (await b.get('/api/me')).json;
  assert.equal(me.billing.reason, 'trial');
  assert.equal(me.billing.trialDaysLeft, 14);
  assert.equal(me.trialIntroAt, null);
  assert.equal(me.firstSyncAt, null);

  const billing = (await b.get('/api/billing')).json;
  assert.deepEqual(billing.plans.map((p) => [p.id, p.amount, p.period]), [['monthly', 9900, 'monthly'], ['yearly', 99900, 'yearly']]);

  const seen = await b.post('/api/onboarding/trial-intro');
  assert.ok(seen.json.trialIntroAt);
  assert.equal((await b.post('/api/onboarding/trial-intro')).json.trialIntroAt, seen.json.trialIntroAt);
  assert.equal((await b.get('/api/me')).json.trialIntroAt, seen.json.trialIntroAt);
});

/* ---------- the first sync ---------- */

test('the first sync reads all of last month and this month so far, in batches, and nothing older', async () => {
  const b = browsers.asha;
  const before = state.model.calls;
  const batches = await firstSync(b);
  modelCalls.asha = state.model.calls - before;

  const last = batches.at(-1);
  assert.equal(last.done, true, JSON.stringify(last));
  assert.ok(batches.length >= 2, `expected several batches, got ${batches.length}`);
  assert.equal(last.since, localDate(startOfPreviousMonth()));

  const spends = await emailSpends(b);
  const ids = new Set(spends.map((e) => e.emailId));
  const { edge, spends: sent } = inboxes.asha;
  assert.equal(spends.length, inboxes.asha.expectedSpends);
  assert.ok(ids.has(edge.firstMinute.id), '00:10 India time on the 1st of last month is read');
  assert.equal(spends.find((e) => e.emailId === edge.firstMinute.id).date, localDate(startOfPreviousMonth()));
  assert.ok(!ids.has(edge.beforeWindow.id), '23:10 the night before is not');
  assert.equal([sent[3].id, edge.duplicate.id].filter((id) => ids.has(id)).length, 1, 'a double-sent alert is recorded once');
  assert.ok(!ids.has(edge.otp.id) && !ids.has(edge.promo.id), 'an OTP and an offer are not spends');
  assert.ok(spends.every((e) => e.cardLast4 === '4417' && e.bank === 'HDFC'));
  assert.ok(spends.some((e) => e.merchant === 'Amazon' && e.needsReview), 'an unsure category asks for a look');
  assert.ok((await b.get('/api/me')).json.firstSyncAt);
});

test("an account learns its bank's alert format and stops paying the model for merchants it knows", async () => {
  const b = browsers.asha;
  const templates = ledgerOf('asha').alertTemplates['alerts@hdfcbank.net'];
  assert.ok(templates.some((t) => t.state === 'live' && t.offeredAt), 'a proven template, offered to the library');
  assert.ok(modelCalls.asha < inboxes.asha.expectedSpends, `the first sync used ${modelCalls.asha} model calls for ${inboxes.asha.expectedSpends} spends`);

  const records = library();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'pending');
  assert.equal(records[0].form, undefined, 'nothing readable is kept for a format one account knows');

  const now = Date.now();
  ['SWIGGY BANGALORE IN', 'ZEPTO MARKETPLACE PVT', 'UBER INDIA SYSTEMS'].forEach((merchant, i) => {
    deliverMail('asha', hdfcAlert('asha', { amount: 120 + i, merchant, at: now - (10 - i) * MIN }));
  });
  const before = state.model.calls;
  const r = (await b.post('/api/sync')).json;
  assert.equal(r.added, 3);
  assert.equal(r.fromTemplates, 3);
  assert.equal(state.model.calls - before, 0, 'known merchants in a known format cost no model calls');
});

/* ---------- shared formats ---------- */

test('three accounts that learn the same format on their own publish it, with nothing personal in it', async () => {
  for (const key of ['vikram', 'meera']) {
    const { browser } = await signIn(base, key);
    browsers[key] = browser;
    await browser.post('/api/onboarding/trial-intro');
    assert.equal((await firstSync(browser)).at(-1).done, true);
    if (key === 'vikram') assert.deepEqual(library().map((r) => [r.status, r.contributors.length]), [['pending', 2]]);
  }

  const [record] = library();
  assert.equal(record.status, 'published');
  assert.equal(record.contributors.length, 3);

  // Hashes are hex and could contain any digits, so only the readable parts are searched.
  const { key, contributors, disputes, ...readable } = record;
  const text = JSON.stringify(readable).toLowerCase();
  const words = Object.values(PERSONAS).flatMap((p) => [...p.name.toLowerCase().split(' '), p.email, p.sub]);
  for (const word of [...words, 'swiggy', 'zepto', 'uber', 'amazon']) {
    assert.doesNotMatch(text, new RegExp(`\\b${word.replace(/[.@-]/g, '\\$&')}\\b`), `the library holds "${word}"`);
  }
  for (const number of ['4417', '8812', '1034', '642', '1,299']) assert.equal(text.includes(number), false, `the library holds ${number}`);
});

test('a fourth account adopts the shared format, proves it with its own model, and needs fewer model calls', async () => {
  const { browser } = await signIn(base, 'dev');
  browsers.dev = browser;
  await browser.post('/api/onboarding/trial-intro');
  const before = state.model.calls;
  assert.equal((await firstSync(browser)).at(-1).done, true);
  modelCalls.dev = state.model.calls - before;

  const templates = ledgerOf('dev').alertTemplates['alerts@hdfcbank.net'];
  const adopted = templates.find((t) => t.origin === 'shared');
  assert.ok(adopted, 'adopted from the library');
  assert.equal(adopted.state, 'live');
  assert.equal(adopted.trialAgreements, 2);
  assert.ok(!templates.some((t) => t.origin !== 'shared'), 'nothing had to be learned from scratch');
  assert.ok(modelCalls.dev < modelCalls.asha, `dev used ${modelCalls.dev} model calls, asha ${modelCalls.asha}`);
  assert.equal((await emailSpends(browser)).length, inboxes.dev.expectedSpends);
  assert.equal(library()[0].contributors.length, 3, 'an adopted format is never offered back');
});

test('a format only one account uses is learned there but never published', async () => {
  const { browser } = await signIn(base, 'nisha');
  browsers.nisha = browser;
  await browser.post('/api/onboarding/trial-intro');
  await firstSync(browser);

  const icici = ledgerOf('nisha').alertTemplates['credit_cards@icicibank.com'] || [];
  assert.ok(icici.some((t) => t.state === 'live'), 'Nisha still gets her own template');
  const records = library();
  assert.equal(records.filter((r) => r.status === 'published').length, 1);
  assert.equal(records.filter((r) => r.status === 'pending').length, 1);
  assert.ok((await emailSpends(browser)).every((e) => e.bank === 'ICICI' && e.cardLast4 === '2210'));
});

/* ---------- staying up to date ---------- */

test('checking email now (pull to refresh) picks up a new alert exactly once', async () => {
  const b = browsers.vikram;
  deliverMail('vikram', hdfcAlert('vikram', { amount: 875, merchant: 'APOLLO PHARMACY', at: Date.now() - 3 * MIN }));
  assert.equal((await b.post('/api/sync')).json.added, 1);
  const again = (await b.post('/api/sync')).json;
  assert.equal(again.added, 0);
  assert.ok(again.alreadySeen >= 1);
  assert.ok((await emailSpends(b)).some((e) => e.merchant === 'Apollo' && e.category === 'Health'));
});

test('the scheduled poll needs its key, reads accounts in their trial, and skips unpaid ones', async () => {
  const anon = client(base);
  assert.equal((await anon.post('/api/cron/poll')).status, 401);
  assert.equal((await anon.post('/api/cron/poll', {}, { headers: { 'X-Cron-Key': 'wrong' } })).status, 401);

  await users.saveUser('g-meera', { createdAt: new Date(Date.now() - 20 * DAY).toISOString() });
  meeraMissed = deliverMail('meera', hdfcAlert('meera', { amount: 1450, merchant: 'ZEPTO MARKETPLACE PVT', at: Date.now() - 4 * MIN }));
  deliverMail('asha', hdfcAlert('asha', { amount: 333, merchant: 'UBER INDIA SYSTEMS', at: Date.now() - 4 * MIN }));

  const run = await anon.post('/api/cron/poll', {}, CRON);
  assert.equal(run.status, 200);
  assert.equal(run.json.accounts, 4);
  assert.equal(run.json.unpaid, 1);
  assert.equal(run.json.failed, 0);
  assert.ok(ledgerOf('asha').expenses.some((e) => e.amount === 333));
  assert.ok(!ledgerOf('meera').processedEmailIds.includes(meeraMissed.id), "an unpaid account's email is not read");
});

/* ---------- the paywall and payments ---------- */

test('past the trial the app shows only the subscribe screen, and data export still works', async () => {
  const b = browsers.meera;
  const blocked = await b.get('/api/expenses');
  assert.equal(blocked.status, 402);
  assert.equal(blocked.json.paymentRequired, true);
  assert.equal((await b.post('/api/sync')).status, 402);
  assert.equal((await b.post('/api/sync/first')).status, 402);
  assert.equal((await b.get('/api/loans')).status, 402);

  const me = await b.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.billing.reason, 'trialEnded');
  assert.equal((await b.get('/api/billing')).status, 200);
  const csv = await b.get('/api/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /Zepto/);
  assert.ok((await users.getUser('g-meera')).pausedForPaymentAt);
});

test('subscribing after the trial charges now; the app reopens and catches up on alerts missed while locked', async () => {
  const b = browsers.meera;
  const order = await b.post('/api/billing/subscribe', { plan: 'monthly' });
  assert.equal(order.status, 200);
  assert.equal(order.json.keyId, 'rzp_test_e2ekey');
  assert.deepEqual(order.json.prefill, { name: 'Meera Iyer', email: 'meera.iyer@gmail.com' });
  const created = razorpay.last('/v1/subscriptions').body;
  assert.equal(created.plan_id, 'plan_e2e_monthly');
  assert.equal(created.start_at, undefined);
  assert.deepEqual(created.notes, { accountId: 'g-meera', plan: 'monthly' });

  const forged = { ...checkoutResponse(order.json.subscriptionId), razorpay_signature: 'f'.repeat(64) };
  assert.equal((await b.post('/api/billing/verify', forged)).status, 400);
  assert.equal((await b.get('/api/expenses')).status, 402, 'a forged confirmation opens nothing');

  razorpay.charge(order.json.subscriptionId);
  const verified = await b.post('/api/billing/verify', checkoutResponse(order.json.subscriptionId));
  assert.equal(verified.status, 200);
  assert.equal(verified.json.reason, 'paid');
  assert.equal(verified.json.renews, true);

  assert.equal((await b.get('/api/expenses')).status, 200);
  assert.equal((await b.get('/api/me')).json.firstSyncAt, null, 'the first sync runs again');
  await firstSync(b);
  assert.ok(ledgerOf('meera').expenses.some((e) => e.emailId === meeraMissed.id), 'the alert from the locked days is read');
  meeraSub = order.json.subscriptionId;
});

test("Razorpay's webhooks are verified, applied once, and can't pay for another account", async () => {
  const sub = razorpay.get(meeraSub);
  const event = webhookEvent('subscription.charged', sub, { payment: true });
  const first = await deliverWebhook(base, event);
  assert.equal(first.status, 200);
  assert.equal((await deliverWebhook(base, event, { id: first.id })).status, 200);
  assert.equal((await users.getUser('g-meera')).billing.recentEventIds.filter((id) => id === first.id).length, 1);

  assert.equal((await deliverWebhook(base, event, { secret: 'not-the-secret' })).status, 400);

  const relabelled = webhookEvent('subscription.charged', { ...sub, current_end: unix(Date.now() + 400 * DAY), notes: { accountId: 'g-asha' } }, { payment: true });
  assert.equal((await deliverWebhook(base, relabelled)).status, 200);
  assert.equal((await users.getUser('g-asha')).billing, undefined, "Meera's subscription pays nothing for Asha");
});

test('subscribing during the trial starts billing when it ends; cancelling before then keeps the trial', async () => {
  const b = browsers.vikram;
  const order = await b.post('/api/billing/subscribe', { plan: 'yearly' });
  assert.equal(order.status, 200);
  const created = razorpay.last('/v1/subscriptions').body;
  const trialEndsAt = Date.parse((await b.get('/api/me')).json.billing.trialEndsAt);
  assert.equal(created.start_at, unix(trialEndsAt));
  assert.equal(created.total_count, 10);

  const sub = razorpay.authenticate(order.json.subscriptionId);
  assert.equal((await deliverWebhook(base, webhookEvent('subscription.authenticated', sub))).status, 200);
  const billing = (await b.get('/api/billing')).json;
  assert.equal(billing.status, 'authenticated');
  assert.equal(billing.reason, 'trial');
  assert.equal(billing.renews, true);
  assert.equal(billing.startAt, new Date(unix(trialEndsAt) * 1000).toISOString());

  const cancelled = await b.post('/api/billing/cancel');
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal(cancelled.json.reason, 'trial');
  assert.equal(cancelled.json.entitled, true);
  assert.deepEqual(razorpay.last(`/v1/subscriptions/${order.json.subscriptionId}/cancel`).body, { cancel_at_cycle_end: false });
});

test('cancelling a paid plan keeps the paid days; subscribing again starts when they end', async () => {
  const b = browsers.meera;
  const cancelled = await b.post('/api/billing/cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal(cancelled.json.entitled, true);
  assert.equal(cancelled.json.renews, false);
  assert.equal((await b.get('/api/expenses')).status, 200);
  assert.equal((await b.post('/api/billing/cancel')).status, 409);

  const again = await b.post('/api/billing/subscribe', { plan: 'monthly' });
  assert.equal(again.status, 200);
  assert.equal(razorpay.last('/v1/subscriptions').body.start_at, unix(Date.parse(cancelled.json.paidThrough)));
  meeraSub = again.json.subscriptionId;
});

test('a renewal that fails once the paid days are over locks the app again', async () => {
  const b = browsers.meera;
  const account = await users.getUser('g-meera');
  await users.saveUser('g-meera', { billing: { ...account.billing, paidThrough: new Date(Date.now() - 2 * DAY).toISOString() } });
  const sub = razorpay.halt(meeraSub);
  assert.equal((await deliverWebhook(base, webhookEvent('subscription.halted', sub))).status, 200);
  assert.equal((await users.getUser('g-meera')).billing.status, 'halted');
  assert.equal((await b.get('/api/expenses')).status, 402);
  assert.equal((await b.get('/api/billing')).json.reason, 'lapsed');
});

/* ---------- privacy and safety ---------- */

test('a PIN locks every data route, billing included, and only the right PIN opens it', async () => {
  const b = browsers.asha;
  assert.equal((await b.post('/api/pin', { pin: '4826' })).status, 200);
  await b.post('/api/pin/lock');
  assert.equal((await b.get('/api/expenses')).status, 423);
  assert.equal((await b.get('/api/billing')).status, 423);
  assert.equal((await b.post('/api/pin/verify', { pin: '0000' })).status, 403);
  assert.equal((await b.post('/api/pin/verify', { pin: '4826' })).status, 200);
  assert.equal((await b.get('/api/expenses')).status, 200);
});

test('each account only ever sees its own spends', async () => {
  for (const key of ['asha', 'vikram', 'dev', 'nisha']) {
    const cards = new Set((await emailSpends(browsers[key])).map((e) => e.cardLast4));
    assert.deepEqual([...cards], [PERSONAS[key].card], key);
  }
});

test('when the model is unavailable, alerts wait instead of being lost', async () => {
  const b = browsers.dev;
  const alert = deliverMail('dev', hdfcAlert('dev', { amount: 649, merchant: 'NETFLIX COM', at: Date.now() - 2 * MIN }));
  state.model.down = true;
  const failed = (await b.post('/api/sync')).json;
  state.model.down = false;
  assert.match(failed.abortedReason, /invalid or revoked/);
  assert.equal(failed.added, 0);
  assert.ok(!ledgerOf('dev').processedEmailIds.includes(alert.id));

  assert.equal((await b.post('/api/sync')).json.added, 1);
});

test('when Google access is revoked, polling stops for that account and reconnecting catches up', async () => {
  state.revokedPersonas.add('dev');
  const run = await client(base).post('/api/cron/poll', {}, CRON);
  assert.equal(run.status, 200);
  assert.equal(run.json.needsReauth, 1);
  assert.equal((await users.getUser('g-dev')).needsReauth, true);

  const paused = await browsers.dev.get('/api/me');
  assert.equal(paused.status, 401);
  assert.match(paused.json.loginUrl, /intent=reconnect/);

  state.revokedPersonas.delete('dev');
  const { done } = await signIn(base, 'dev', { intent: 'reconnect', browser: browsers.dev });
  assert.equal(done.status, 302);
  const me = await browsers.dev.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.firstSyncAt, null, 'a catch-up first sync is queued');
  assert.equal((await users.getUser('g-dev')).needsReauth, false);
});

test('deleting an account cancels a plan that would renew, revokes Google, and removes the record and ledger', async () => {
  const b = browsers.vikram;
  const order = await b.post('/api/billing/subscribe', { plan: 'monthly' });
  const sub = razorpay.authenticate(order.json.subscriptionId);
  await deliverWebhook(base, webhookEvent('subscription.authenticated', sub));

  const gone = await b.del('/api/account', { deleteDriveFile: true });
  assert.equal(gone.status, 200);
  assert.equal(razorpay.get(order.json.subscriptionId).status, 'cancelled');
  assert.ok(state.revokedTokens.some((t) => t.startsWith('rt:vikram:')));
  assert.equal(await users.getUser('g-vikram'), null);
  assert.equal(state.drives.get('vikram').size, 0);
  assert.equal((await b.get('/api/me')).status, 401);
});
