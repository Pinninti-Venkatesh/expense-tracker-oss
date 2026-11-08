/**
 * The public demo (demo.js), started as its own process the way it runs in
 * production, and used by two visitors at once.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { client, firstSync } from './setup.js';

const PORT = 18300;
const base = `http://localhost:${PORT}`;
let demo;
let output = '';

before(async () => {
  demo = spawn(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./demo.js', import.meta.url))], {
    env: { ...process.env, PORT: String(PORT), SANDBOX_TTL_MINUTES: '60', MAX_SANDBOXES: '3' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  demo.stdout.on('data', (d) => { output += d; });
  demo.stderr.on('data', (d) => { output += d; });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error(`The demo did not start:\n${output}`);
});

after(() => demo?.kill());

/** Sign-in as a visitor does it: app → fake chooser → sandbox → back to the app. */
async function visit(as) {
  const browser = client(base);
  const login = await browser.get('/api/login');
  assert.equal(login.status, 302);
  const chooser = login.headers.get('location');
  assert.ok(chooser.startsWith('/__demo/auth?'), chooser);

  const page = await browser.get(chooser);
  assert.match(page.text, /made-up bank alerts/);
  const start = new URL(`${base}${chooser}`).searchParams.get('state');

  const made = await browser.get(`/__demo/start?${new URLSearchParams({ as, state: start })}`);
  const callback = made.headers.get('location');
  assert.ok(callback.startsWith('/api/login/callback?'), callback);
  const done = await browser.get(callback);
  assert.equal(done.status, 302, done.text);
  return browser;
}

test('the website is the front door: its pages, assets and demo link work, and nothing on it reaches another host', async () => {
  const visitor = client(base);
  const home = await visitor.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Every spend, <span class="quiet">without typing a thing/);
  assert.doesNotMatch(home.text, /\{\{\w+\}\}/, 'every placeholder is filled');
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);

  const refs = [...home.text.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]).filter((u) => u !== '/demo' && u !== '/privacy' && u !== '/');
  const css = await (await fetch(`${base}/site/site.css`)).text();
  refs.push(...[...css.matchAll(/url\('(\/[^']+)'\)/g)].map((m) => m[1]));
  assert.ok(refs.length >= 6, refs.join(', '));
  for (const ref of refs) assert.equal((await fetch(`${base}${ref}`)).status, 200, ref);

  const privacy = await visitor.get('/privacy');
  assert.match(privacy.text, /Limited Use/);
  assert.doesNotMatch(privacy.text, /\{\{\w+\}\}/);

  const demo = await visitor.get('/demo');
  assert.equal(demo.headers.get('location'), '/api/login');
});

test('a visitor gets a private sandbox with fake alerts, read by the fake model, with no key or Google account', async () => {
  const session = (await client(base).get('/api/session')).json;
  assert.equal(session.product, 'Expenses demo');
  assert.equal(session.googleVerified, true, 'no Google warning step in the demo');

  const asha = await visit('asha');
  assert.equal((await firstSync(asha)).at(-1).done, true);
  const spends = (await asha.get('/api/expenses')).json.expenses;
  assert.ok(spends.length >= 30, `only ${spends.length} spends`);
  assert.match((await asha.get('/api/me')).json.email, /^asha\.rao\+[0-9a-f]{8}@gmail\.com$/);

  const home = await asha.get('/');
  assert.doesNotMatch(home.text, /without typing a thing/, 'once in the demo, / is the app, not the website');
  assert.match(home.text, /<div id="root">/);
});

test('two visitors as the same persona never see or lock each other', async () => {
  const one = await visit('asha');
  const two = await visit('asha');
  assert.notEqual((await one.get('/api/me')).json.email, (await two.get('/api/me')).json.email);

  await firstSync(one);
  assert.equal((await one.post('/api/expenses', { amount: 4321, merchant: 'Only in sandbox one', category: 'Food', paymentType: 'Cash' })).status, 201);
  assert.equal((await one.post('/api/pin', { pin: '482913' })).status, 200);

  const theirs = await two.get('/api/expenses');
  assert.equal(theirs.status, 200, "one visitor's PIN doesn't lock another");
  assert.ok(!theirs.json.expenses.some((e) => e.merchant === 'Only in sandbox one'));
});

test('the chooser only offers real personas, and the oldest sandbox makes way past the cap', async () => {
  const stray = await client(base).get('/__demo/start?as=nobody&state=x');
  assert.equal(stray.headers.get('location'), '/');

  // MAX_SANDBOXES is 3 and three exist: the first visitor's sandbox is recycled.
  const first = await visit('nisha');
  assert.equal((await first.get('/api/me')).status, 200);
  const newest = await visit('asha');
  assert.equal((await newest.get('/api/me')).status, 200);
  assert.equal((await first.get('/api/me')).status, 200, 'the most recent sandboxes survive');
});
