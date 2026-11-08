/**
 * The app with fake Google, Gmail, Drive, Bedrock and Razorpay, to click through
 * in a browser. Nothing leaves this machine.
 *
 *   npm run mock
 *   MOCK_MAIL=app-password npm run mock    (the simple path: first-run screen,
 *                                           invites, Gmail app passwords)
 *
 * App:          http://localhost:8080
 * Fake Google:  http://localhost:8081 (the account chooser, plus the helpers below)
 *
 * Razorpay Checkout can't run against fake keys, so the browser walkthrough
 * stands in for it (see README in this folder).
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from './setup.js';

const port = Number(process.env.E2E_PORT || 8080);
// The simple path starts as a fresh install: no household, no Claude key.
const simple = process.env.MOCK_MAIL === 'app-password';
const dataDir = simple ? fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-mock-data-')) : null;
const { fakes, dir } = await startApp({
  port,
  googlePort: port + 1,
  keepData: true,
  ...(simple && {
    hosted: false,
    env: {
      MAIL_ACCESS: 'app-password', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '', ANTHROPIC_API_KEY: '', DATA_DIR: dataDir,
    },
  }),
});
const users = await import('../server/users/store.js');
const { PERSONAS, buildInbox, iciciAlert, deliverMail, hdfcAlert, state, razorpay, webhookEvent, deliverWebhook, time } = fakes;

state.razorpay.autoChargeOnFetch = true;
for (const key of ['asha', 'vikram', 'meera', 'dev']) buildInbox(key);
buildInbox('nisha', { alert: iciciAlert });

const escape = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const google = express();

google.get('/auth', (req, res) => {
  const { state: oauthState, redirect_uri: redirect } = req.query;
  const rows = Object.entries(PERSONAS).map(([key, p]) => `
    <a class="row" href="${escape(`${redirect}?state=${encodeURIComponent(oauthState)}&code=persona:${key}`)}">
      <b>${escape(p.name)}</b><small>${escape(p.email)}${p.identityOnly ? ' · unticks Gmail and Drive' : ''}</small>
    </a>`).join('');
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Choose an account (fake Google)</title>
    <style>body{font:15px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f1f3f4;padding:16px}
    main{background:#fff;border-radius:12px;padding:24px;max-width:420px;width:100%;box-shadow:0 1px 3px #0002}
    h1{font-size:22px;font-weight:400;margin:0 0 4px}p{color:#5f6368;margin:0 0 16px}.row{display:grid;padding:12px;border-top:1px solid #eee;color:#202124;text-decoration:none}
    .row:hover{background:#f8f9fa}small{color:#5f6368}</style>
    <main><h1>Choose an account</h1><p>Fake Google for local testing. No real account is used.</p>${rows}</main>`);
});

// Helpers for the walkthrough. Local only.
google.get('/admin/mail/:key', (req, res) => {
  const message = deliverMail(req.params.key, hdfcAlert(req.params.key, {
    amount: Number(req.query.amount || 499),
    merchant: String(req.query.merchant || 'SWIGGY BANGALORE IN'),
    at: Date.now() - time.MIN,
  }));
  res.json({ delivered: message.id });
});

google.get('/admin/expire/:key', async (req, res) => {
  const sub = PERSONAS[req.params.key]?.sub;
  await users.saveUser(sub, { createdAt: new Date(Date.now() - 20 * time.DAY).toISOString() });
  res.json({ expired: sub });
});

google.get('/admin/charge/:key', async (req, res) => {
  const account = await users.getUser(PERSONAS[req.params.key]?.sub);
  const id = account?.billing?.subscriptionId;
  if (!id) return res.status(404).json({ error: 'no subscription' });
  const sub = razorpay.charge(id);
  res.json(await deliverWebhook(`http://localhost:${port}`, webhookEvent('subscription.charged', sub, { payment: true })));
});

google.get('/admin/state', async (req, res) => res.json({
  modelCalls: state.model.calls,
  accounts: (await Promise.all(Object.values(PERSONAS).map((p) => users.getUser(p.sub)))).filter(Boolean)
    .map(({ id, email, billing, createdAt }) => ({ id, email, createdAt, billing })),
  subscriptions: [...state.razorpay.subs.values()].map(({ id, status, plan_id: plan, start_at: startAt }) => ({ id, status, plan, startAt })),
}));

google.listen(port + 1, () => {
  console.log(`\nMock app:     http://localhost:${port}`);
  console.log(`Fake Google:  http://localhost:${port + 1}/admin/state`);
  console.log(`Data folder:  ${dataDir || dir}\n`);
  if (simple) {
    import('../server/install.js').then((install) => {
      console.log(`Setup code:   ${install.setupCode()}`);
      console.log('Claude key:   any key containing "good", e.g. sk-ant-api03-good-mock-key-0001');
      console.log('App passwords (fake Gmail):');
      for (const key of ['asha', 'vikram', 'meera', 'dev', 'nisha']) console.log(`  ${PERSONAS[key].email.padEnd(26)} ${fakes.appPasswordOf(key)}`);
      console.log('');
    });
  }
});
