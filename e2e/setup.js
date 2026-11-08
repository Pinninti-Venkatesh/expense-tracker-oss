import { mock } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Starts the real server in this process with fakes at its edges (fakes.js).
 * Needs `node --experimental-test-module-mocks`.
 *
 * `hosted` switches on every optional feature (payments, shared formats, legal
 * pages), as for a public paid service; off is a self-hosted install. `env`
 * overrides anything else.
 */
export async function startApp({ port, googlePort = port + 1, keepData = false, hosted = true, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-e2e-'));
  const base = `http://localhost:${port}`;

  Object.assign(process.env, {
    NODE_ENV: 'development',
    PORT: String(port),
    PRODUCT_NAME: 'Expenses',
    SUPPORT_EMAIL: 'support@example.com',
    OPERATOR_NAME: 'E2E Operator',
    POLICY_EFFECTIVE_DATE: '2026-09-15',
    GOOGLE_CLIENT_ID: 'e2e-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
    GOOGLE_REDIRECT_URI: `${base}/api/login/callback`,
    GOOGLE_APP_VERIFIED: 'false',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    CRON_SECRET: 'e2e-cron-secret',
    USER_STORE: 'file',
    USER_STORE_FILE: path.join(dir, 'users.json'),
    ALLOWED_EMAILS: '',
    BILLING_ENABLED: String(hosted),
    SHARED_TEMPLATES_ENABLED: String(hosted),
    LEGAL_PAGES_ENABLED: String(hosted),
    MAX_USERS: '50',
    TRIAL_DAYS: '14',
    APP_TIMEZONE: 'Asia/Kolkata',
    POLL_LOOKBACK_HOURS: '24',
    // Tests drive every check themselves.
    POLL_INTERVAL_MINUTES: '0',
    TEMPLATE_LIBRARY_MIN_ACCOUNTS: '3',
    TEMPLATE_LIBRARY_FILE: path.join(dir, 'template-library.json'),
    RAZORPAY_KEY_ID: 'rzp_test_e2ekey',
    RAZORPAY_KEY_SECRET: 'e2e_key_secret',
    RAZORPAY_WEBHOOK_SECRET: 'e2e_webhook_secret',
    RAZORPAY_PLAN_MONTHLY: 'plan_e2e_monthly',
    RAZORPAY_PLAN_YEARLY: 'plan_e2e_yearly',
    // Either provider runs against the same fake model, so E2E_AI_PROVIDER=bedrock
    // exercises the other path.
    AI_PROVIDER: process.env.E2E_AI_PROVIDER || 'anthropic',
    ANTHROPIC_API_KEY: 'e2e',
    AWS_ACCESS_KEY_ID: 'e2e',
    AWS_SECRET_ACCESS_KEY: 'e2e',
  }, env);

  const fakes = await import('./fakes.js');
  fakes.state.googleBase = `http://localhost:${googlePort}`;
  mock.module('googleapis', { namedExports: { google: fakes.fakeGoogle } });
  mock.module('imapflow', { namedExports: { ImapFlow: fakes.FakeImapFlow } });
  mock.module('@anthropic-ai/sdk', { defaultExport: fakes.FakeClaude });
  mock.module('@anthropic-ai/bedrock-sdk', { namedExports: { AnthropicBedrockMantle: fakes.FakeClaude } });
  fakes.installFetch();

  await import('../server/index.js');
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }

  const cleanup = () => {
    if (!keepData) fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, dir, fakes, cleanup, files: { users: process.env.USER_STORE_FILE, library: process.env.TEMPLATE_LIBRARY_FILE } };
}

/** A browser, as far as cookies and redirects go. */
export function client(base) {
  const jar = new Map();

  async function request(method, route, { body, headers = {} } = {}) {
    const res = await fetch(base + route, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(jar.size && { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }),
        ...headers,
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /max-age=0/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  return {
    jar,
    get: (route, opts) => request('GET', route, opts),
    post: (route, body = {}, opts) => request('POST', route, { ...opts, body }),
    put: (route, body = {}) => request('PUT', route, { body }),
    del: (route, body = {}) => request('DELETE', route, { body }),
  };
}

/** Continue with Google, pick a persona on the fake consent screen, come back. */
export async function signIn(base, key, { intent, browser = client(base) } = {}) {
  const start = await browser.get(`/api/login${intent ? `?intent=${intent}` : ''}`);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await browser.get(`/api/login/callback?state=${encodeURIComponent(state)}&code=persona:${key}`);
  return { browser, start, done };
}

/** Runs the first sync the way the app does: batch after batch until done. */
export async function firstSync(browser) {
  const batches = [];
  for (let i = 0; i < 20; i++) {
    const r = await browser.post('/api/sync/first');
    batches.push(r.json);
    if (r.status !== 200 || r.json?.done || r.json?.error) break;
  }
  return batches;
}
