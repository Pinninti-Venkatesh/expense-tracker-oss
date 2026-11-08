import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-test-'));
Object.assign(process.env, {
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  USER_STORE: 'file',
  USER_STORE_FILE: path.join(dir, 'users.json'),
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'key_secret',
  RAZORPAY_WEBHOOK_SECRET: 'wh_secret',
  RAZORPAY_PLAN_MONTHLY: 'plan_monthly',
  RAZORPAY_PLAN_YEARLY: 'plan_yearly',
  TRIAL_DAYS: '14',
  BILLING_ENABLED: 'true',
});

const { default: config } = await import('../server/config.js');
const users = await import('../server/users/store.js');
const store = await import('../server/drive/store.js');
const { runAsUser, contextUser } = await import('../server/context.js');
const razorpay = await import('../server/billing/razorpay.js');
const { updateBilling } = await import('../server/billing/records.js');
const { requireEntitlement } = await import('../server/billing/gate.js');
const { default: billingRoutes, handleWebhook } = await import('../server/routes/billing.js');

const DAY = 24 * 3600 * 1000;
const unix = (ms) => Math.floor(ms / 1000);
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/* ---------- a fake Razorpay ---------- */

const rzp = { subs: new Map(), calls: [], seq: 0 };

razorpay.__setFetchForTests(async (url, opts) => {
  const u = new URL(url);
  const method = opts.method;
  const body = opts.body ? JSON.parse(opts.body) : null;
  rzp.calls.push({ method, path: u.pathname, body, auth: opts.headers.Authorization });
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  let m;
  if (method === 'POST' && u.pathname === '/v1/subscriptions') {
    const id = `sub_${++rzp.seq}`;
    const sub = {
      id, entity: 'subscription', plan_id: body.plan_id, status: 'created', start_at: body.start_at || null,
      current_start: null, current_end: null, paid_count: 0, total_count: body.total_count, notes: body.notes, created_at: unix(Date.now()),
    };
    rzp.subs.set(id, sub);
    return reply(200, sub);
  }
  if (method === 'GET' && (m = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
    return rzp.subs.has(m[1]) ? reply(200, rzp.subs.get(m[1])) : reply(400, { error: { description: 'The id provided does not exist' } });
  }
  if (method === 'POST' && (m = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)\/cancel$/))) {
    const sub = rzp.subs.get(m[1]);
    Object.assign(sub, { status: 'cancelled', ended_at: unix(Date.now()) });
    return reply(200, sub);
  }
  if (method === 'GET' && (m = u.pathname.match(/^\/v1\/plans\/([^/]+)$/))) {
    const yearly = m[1] === 'plan_yearly';
    return reply(200, { id: m[1], entity: 'plan', period: yearly ? 'yearly' : 'monthly', interval: 1, item: { name: yearly ? 'Yearly' : 'Monthly', amount: yearly ? 99900 : 9900, currency: 'INR' } });
  }
  return reply(404, { error: { description: 'unknown route' } });
});

/** Razorpay marks a subscription paid for one cycle, as its charge would. */
function chargeInRazorpay(id, { from = Date.now(), days = 30 } = {}) {
  const sub = rzp.subs.get(id);
  Object.assign(sub, { status: 'active', current_start: unix(from), current_end: unix(from + days * DAY), paid_count: (sub.paid_count || 0) + 1 });
  return sub;
}

/* ---------- a fake Drive, one per account ---------- */

const driveFiles = new Map();
store.__setDriveForTests(() => {
  const { id: uid } = contextUser();
  return {
    files: {
      list: async () => ({ data: { files: driveFiles.has(uid) ? [{ id: uid }] : [] } }),
      create: async ({ media }) => {
        driveFiles.set(uid, media.body);
        return { data: { id: uid } };
      },
      get: async () => ({ data: driveFiles.get(uid) }),
      update: async ({ media }) => {
        let body = '';
        for await (const chunk of media.body) body += chunk;
        driveFiles.set(uid, body);
        return { data: {} };
      },
    },
  };
});

const ledgerOf = (id) => JSON.parse(driveFiles.get(id) || '{}');

/* ---------- the app under test ---------- */

let server;
let base;

before(async () => {
  const app = express();
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), handleWebhook);
  app.use(express.json());
  // Stands in for requireAuth: the test names the account in a header.
  app.use('/api', async (req, res, next) => {
    req.account = await users.getUser(req.get('x-account'));
    if (!req.account) return res.status(401).json({ error: 'Sign in required' });
    runAsUser(req.account, () => next());
  });
  app.use('/api', requireEntitlement);
  app.use('/api', billingRoutes);
  app.get('/api/me', (req, res) => res.json({ ok: true }));
  app.get('/api/expenses', (req, res) => res.json({ expenses: [] }));
  app.post('/api/sync', (req, res) => res.json({ added: 0 }));
  app.get('/api/export.csv', (req, res) => res.type('text/csv').send('date,amount'));
  app.use((err, req, res, next) => {
    const status = Number(err.status) || 500;
    res.status(status).json({ error: status < 500 ? err.message : 'Something went wrong. Please try again.' });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rzp.calls.length = 0;
});

let accountSeq = 0;
async function newAccount({ createdDaysAgo = 1, billing } = {}) {
  const id = `acc_${++accountSeq}`;
  await users.saveUser(id, {
    email: `${id}@example.com`, name: `Person ${accountSeq}`, status: 'active',
    createdAt: new Date(Date.now() - createdDaysAgo * DAY).toISOString(), ...(billing && { billing }),
  });
  return id;
}

const call = async (account, method, route, body) => {
  const res = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-account': account },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const webhook = async (event, { id = crypto.randomUUID(), secret = 'wh_secret', raw } = {}) => {
  const body = raw ?? JSON.stringify(event);
  const res = await fetch(`${base}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmac(secret, body), 'x-razorpay-event-id': id },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const chargedEvent = (sub) => ({
  entity: 'event', event: 'subscription.charged', created_at: unix(Date.now()),
  payload: { subscription: { entity: sub }, payment: { entity: { id: 'pay_1', status: 'captured', amount: 9900 } } },
});

/* ---------- plans & subscribing ---------- */

test('the billing screen gets trial state and plan prices read from Razorpay', async () => {
  const acc = await newAccount({ createdDaysAgo: 3 });
  const { status, body } = await call(acc, 'GET', '/billing');
  assert.equal(status, 200);
  assert.equal(body.entitled, true);
  assert.equal(body.reason, 'trial');
  assert.equal(body.trialDaysLeft, 11);
  assert.equal(body.configured, true);
  assert.deepEqual(body.plans.map((p) => [p.id, p.amount, p.period]), [['monthly', 9900, 'monthly'], ['yearly', 99900, 'yearly']]);
  assert.match(rzp.calls[0].auth, /^Basic /);
});

test('subscribing in the trial starts billing when the trial ends, tagged with the account', async () => {
  const acc = await newAccount({ createdDaysAgo: 3 });
  const { status, body } = await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
  assert.equal(status, 200);
  assert.equal(body.keyId, 'rzp_test_key');
  assert.match(body.subscriptionId, /^sub_/);

  const created = rzp.calls.find((c) => c.path === '/v1/subscriptions').body;
  const account = await users.getUser(acc);
  const trialEnds = unix(Date.parse(account.createdAt) + 14 * DAY);
  assert.equal(created.plan_id, 'plan_monthly');
  assert.equal(created.start_at, trialEnds);
  assert.equal(created.total_count, 120);
  assert.deepEqual(created.notes, { accountId: acc, plan: 'monthly' });
  assert.equal(account.billing.subscriptionId, body.subscriptionId);
  assert.equal(account.billing.status, 'created');
});

test('subscribing after the trial starts billing now', async () => {
  const acc = await newAccount({ createdDaysAgo: 30 });
  await call(acc, 'POST', '/billing/subscribe', { plan: 'yearly' });
  const created = rzp.calls.find((c) => c.path === '/v1/subscriptions').body;
  assert.equal(created.plan_id, 'plan_yearly');
  assert.equal(created.start_at, undefined);
  assert.equal(created.total_count, 10);
});

test('reopening checkout reuses the unpaid subscription; switching plan cancels it first', async () => {
  const acc = await newAccount();
  const first = await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
  const again = await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
  assert.equal(again.body.subscriptionId, first.body.subscriptionId);
  assert.equal(rzp.calls.filter((c) => c.path === '/v1/subscriptions').length, 1);

  const switched = await call(acc, 'POST', '/billing/subscribe', { plan: 'yearly' });
  assert.notEqual(switched.body.subscriptionId, first.body.subscriptionId);
  assert.ok(rzp.calls.some((c) => c.path === `/v1/subscriptions/${first.body.subscriptionId}/cancel`));
  const account = await users.getUser(acc);
  assert.deepEqual(account.billing.previousSubscriptionIds, [first.body.subscriptionId]);
});

test('a second plan is refused while one can still charge', async () => {
  const acc = await newAccount({ billing: { subscriptionId: 'sub_live', status: 'active', plan: 'monthly' } });
  const { status, body } = await call(acc, 'POST', '/billing/subscribe', { plan: 'yearly' });
  assert.equal(status, 409);
  assert.equal(body.error, 'You already have a plan.');
  assert.equal(rzp.calls.length, 0);
});

test('an unknown plan is refused, and so is subscribing when payments are not set up', async () => {
  const acc = await newAccount();
  assert.equal((await call(acc, 'POST', '/billing/subscribe', { plan: 'lifetime' })).status, 400);

  config.billing.enabled = false;
  try {
    const { status, body } = await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
    assert.equal(status, 503);
    assert.match(body.error, /not set up/);
  } finally {
    config.billing.enabled = true;
  }
});

/* ---------- confirming checkout ---------- */

test('checkout is confirmed only with a genuine signature for this account\'s own subscription', async () => {
  const acc = await newAccount({ createdDaysAgo: 30 });
  const { body: opened } = await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
  const other = await newAccount({ createdDaysAgo: 30 });
  const { body: othersSub } = await call(other, 'POST', '/billing/subscribe', { plan: 'monthly' });
  rzp.calls.length = 0;

  const forged = await call(acc, 'POST', '/billing/verify', {
    razorpay_payment_id: 'pay_1', razorpay_subscription_id: opened.subscriptionId, razorpay_signature: hmac('wrong_secret', `pay_1|${opened.subscriptionId}`),
  });
  assert.equal(forged.status, 400);

  // A genuine signature for someone else's subscription doesn't pay for this account.
  const borrowed = await call(acc, 'POST', '/billing/verify', {
    razorpay_payment_id: 'pay_2', razorpay_subscription_id: othersSub.subscriptionId, razorpay_signature: hmac('key_secret', `pay_2|${othersSub.subscriptionId}`),
  });
  assert.equal(borrowed.status, 400);
  assert.equal(rzp.calls.length, 0, 'Razorpay is not even asked');
  assert.equal((await call(acc, 'GET', '/expenses')).status, 402);

  chargeInRazorpay(opened.subscriptionId);
  const genuine = await call(acc, 'POST', '/billing/verify', {
    razorpay_payment_id: 'pay_3', razorpay_subscription_id: opened.subscriptionId, razorpay_signature: hmac('key_secret', `pay_3|${opened.subscriptionId}`),
  });
  assert.equal(genuine.status, 200);
  assert.equal(genuine.body.entitled, true);
  assert.equal(genuine.body.reason, 'paid');
  assert.equal((await call(acc, 'GET', '/expenses')).status, 200);
});

test('a mandate authorised in the trial is recorded without granting paid days', async () => {
  const acc = await newAccount({ createdDaysAgo: 3 });
  const { body: opened } = await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
  rzp.subs.get(opened.subscriptionId).status = 'authenticated';

  const { body } = await call(acc, 'POST', '/billing/verify', {
    razorpay_payment_id: 'pay_auth', razorpay_subscription_id: opened.subscriptionId, razorpay_signature: hmac('key_secret', `pay_auth|${opened.subscriptionId}`),
  });
  assert.equal(body.status, 'authenticated');
  assert.equal(body.paidThrough, null);
  assert.equal(body.reason, 'trial');
  assert.equal(body.renews, true);
});

/* ---------- webhooks ---------- */

test('a webhook with a wrong or missing signature changes nothing', async () => {
  const acc = await newAccount({ createdDaysAgo: 30, billing: { subscriptionId: 'sub_wh1', status: 'created' } });
  const sub = { id: 'sub_wh1', status: 'active', current_end: unix(Date.now() + 30 * DAY), notes: { accountId: acc } };

  assert.equal((await webhook(chargedEvent(sub), { secret: 'not_the_secret' })).status, 400);
  const unsigned = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chargedEvent(sub)) });
  assert.equal(unsigned.status, 400);
  assert.equal((await users.getUser(acc)).billing.status, 'created');
});

test('a charge webhook unlocks the app; a retried delivery is applied once', async () => {
  const acc = await newAccount({ createdDaysAgo: 30, billing: { subscriptionId: 'sub_wh2', status: 'created' } });
  assert.equal((await call(acc, 'GET', '/expenses')).status, 402);

  const end = unix(Date.now() + 30 * DAY);
  const event = chargedEvent({ id: 'sub_wh2', status: 'active', current_end: end, notes: { accountId: acc } });
  assert.equal((await webhook(event, { id: 'evt_same' })).status, 200);
  assert.equal((await webhook(event, { id: 'evt_same' })).status, 200);

  const account = await users.getUser(acc);
  assert.equal(account.billing.paidThrough, new Date(end * 1000).toISOString());
  assert.deepEqual(account.billing.recentEventIds, ['evt_same']);
  assert.equal((await call(acc, 'GET', '/expenses')).status, 200);
});

test("a webhook naming one account but carrying another subscription is ignored", async () => {
  const acc = await newAccount({ createdDaysAgo: 30, billing: { subscriptionId: 'sub_real', status: 'created' } });
  const event = chargedEvent({ id: 'sub_forged', status: 'active', current_end: unix(Date.now() + 365 * DAY), notes: { accountId: acc } });
  assert.equal((await webhook(event)).status, 200);
  assert.equal((await users.getUser(acc)).billing.paidThrough, undefined);
  assert.equal((await call(acc, 'GET', '/expenses')).status, 402);
});

test('events that are not about subscriptions, or have no account, are acknowledged and ignored', async () => {
  assert.deepEqual((await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x' } } } })).body, { ok: true, ignored: true });
  assert.deepEqual((await webhook({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_x', notes: {} } } } })).body, { ok: true, ignored: true });
  assert.equal((await webhook(null, { raw: '{not json' })).status, 400);
});

test('a halted renewal locks the app when the paid days run out', async () => {
  const acc = await newAccount({
    createdDaysAgo: 60,
    billing: { subscriptionId: 'sub_halt', status: 'active', statusAt: unix(Date.now() - 40 * DAY), paidThrough: new Date(Date.now() - 2 * DAY).toISOString() },
  });
  const halted = { entity: 'event', event: 'subscription.halted', created_at: unix(Date.now()), payload: { subscription: { entity: { id: 'sub_halt', status: 'halted', notes: { accountId: acc } } } } };
  await webhook(halted);
  assert.equal((await users.getUser(acc)).billing.status, 'halted');
  const blocked = await call(acc, 'POST', '/sync');
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.paymentRequired, true);
});

/* ---------- the paywall ---------- */

test('past the trial, the paywall still lets through the subscribe screen, CSV export and account details', async () => {
  const acc = await newAccount({ createdDaysAgo: 15 });
  assert.equal((await call(acc, 'GET', '/expenses')).status, 402);
  assert.equal((await call(acc, 'GET', '/me')).status, 200);
  assert.equal((await call(acc, 'GET', '/billing')).status, 200);
  const csv = await fetch(`${base}/api/export.csv`, { headers: { 'x-account': acc } });
  assert.equal(csv.status, 200);
});

test('coming back after the paywall re-runs the first sync, so alerts from the locked days are read', async () => {
  const acc = await newAccount({ createdDaysAgo: 30, billing: { subscriptionId: 'sub_back', status: 'created' } });
  await runAsUser({ id: acc }, () => store.mutate((d) => { d.meta = { firstSyncAt: '2026-08-01T00:00:00.000Z' }; }));

  assert.equal((await call(acc, 'GET', '/expenses')).status, 402);
  assert.ok((await users.getUser(acc)).pausedForPaymentAt);
  assert.equal(ledgerOf(acc).meta.firstSyncAt, '2026-08-01T00:00:00.000Z', 'nothing changes while locked');

  await webhook(chargedEvent({ id: 'sub_back', status: 'active', current_end: unix(Date.now() + 30 * DAY), notes: { accountId: acc } }));
  assert.equal((await call(acc, 'GET', '/expenses')).status, 200);
  assert.equal(ledgerOf(acc).meta.firstSyncAt, null);
  assert.equal((await users.getUser(acc)).pausedForPaymentAt, null);
});

test('an account in its trial is never marked as paused', async () => {
  const acc = await newAccount({ createdDaysAgo: 2 });
  await call(acc, 'GET', '/expenses');
  await call(acc, 'GET', '/billing');
  assert.equal((await users.getUser(acc)).pausedForPaymentAt, undefined);
});

/* ---------- cancelling ---------- */

test('cancelling stops renewal but keeps the days already paid for', async () => {
  const acc = await newAccount({ createdDaysAgo: 30 });
  const { body: opened } = await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
  chargeInRazorpay(opened.subscriptionId);
  await call(acc, 'POST', '/billing/verify', {
    razorpay_payment_id: 'pay_c', razorpay_subscription_id: opened.subscriptionId, razorpay_signature: hmac('key_secret', `pay_c|${opened.subscriptionId}`),
  });

  const { status, body } = await call(acc, 'POST', '/billing/cancel');
  assert.equal(status, 200);
  assert.equal(body.status, 'cancelled');
  assert.equal(body.renews, false);
  assert.equal(body.entitled, true);
  assert.deepEqual(rzp.calls.find((c) => c.path.endsWith('/cancel')).body, { cancel_at_cycle_end: false });

  assert.equal((await call(acc, 'POST', '/billing/cancel')).status, 409);

  // Subscribing again starts when the paid days end, so nothing is charged twice.
  rzp.calls.length = 0;
  await call(acc, 'POST', '/billing/subscribe', { plan: 'monthly' });
  const paidThrough = Date.parse((await users.getUser(acc)).billing.paidThrough);
  assert.equal(rzp.calls.find((c) => c.path === '/v1/subscriptions').body.start_at, unix(paidThrough));
});

/* ---------- concurrency ---------- */

test('simultaneous billing changes for one account are applied one after another', async () => {
  const acc = await newAccount();
  const add = (tag) => updateBilling(acc, async (billing) => {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    return { ...billing, tags: [...(billing.tags || []), tag] };
  });
  await Promise.all([add('checkout'), add('webhook'), add('cancel')]);
  assert.deepEqual((await users.getUser(acc)).billing.tags, ['checkout', 'webhook', 'cancel']);
});
