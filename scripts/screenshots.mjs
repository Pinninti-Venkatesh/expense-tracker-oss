/**
 * Takes the README screenshots from the demo: fake alerts and a fake persona
 * only, so no real data can end up in them.
 *
 *   npm --prefix web run build && node scripts/screenshots.mjs
 *
 * Starts e2e/demo.js, signs in as a sandbox persona over HTTP, adds a loan and
 * an IOU so every screen has something on it, then drives headless Chrome over
 * the DevTools protocol. Writes docs/screenshots/*.png.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, firstSync } from '../e2e/setup.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'docs', 'screenshots');
const PORT = 18600;
const DEVTOOLS = 18601;
const base = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(url, what) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`${what} did not start`);
}

const children = [];
const stop = () => children.forEach((c) => c.kill());
process.on('exit', stop);

// 1. The demo, and a signed-in sandbox with a finished first sync.
children.push(spawn(process.execPath, ['--experimental-test-module-mocks', path.join(root, 'e2e', 'demo.js')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
}));
await waitFor(`${base}/api/health`, 'The demo');

const browser = client(base);
const chooser = (await browser.get('/api/login')).headers.get('location');
const state = new URL(`${base}${chooser}`).searchParams.get('state');
const callback = (await browser.get(`/__demo/start?${new URLSearchParams({ as: 'asha', state })}`)).headers.get('location');
await browser.get(callback);
await firstSync(browser);

const today = new Date();
const monthsAgo = (n) => new Date(today.getFullYear(), today.getMonth() - n, 5).toISOString().slice(0, 10);
await browser.post('/api/loans', {
  name: 'Car loan', type: 'car', principal: 850000, annualRate: 9.1, tenureMonths: 60, startDate: monthsAgo(14),
});
await browser.post('/api/ledger', { direction: 'lent', personName: 'Rohan', amount: 2400, note: 'Concert tickets' });
await browser.post('/api/ledger', { direction: 'borrowed', personName: 'Priya', amount: 650, note: 'Cab to the airport' });

// 2. Headless Chrome, carrying the sandbox's session cookie.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
children.push(spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEVTOOLS}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank',
], { stdio: 'ignore' }));
await waitFor(`http://127.0.0.1:${DEVTOOLS}/json/version`, 'Chrome');

const target = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Network.enable');
for (const [name, value] of browser.jar) await send('Network.setCookie', { name, value, url: base });

async function shot(name, { width, height, mobile, dark = false, tab }) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url: `${base}/` });
  await sleep(2500);
  if (tab) {
    await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === ${JSON.stringify(tab)})?.click()`,
    });
    await sleep(1200);
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`docs/screenshots/${name}.png`);
}

const phone = { width: 390, height: 844, mobile: true };
await shot('home', phone);
await shot('spends', { ...phone, tab: 'Spends' });
await shot('loans', { ...phone, tab: 'Loans' });
await shot('people', { ...phone, tab: 'People' });
await shot('desktop', { width: 1440, height: 900, mobile: false });

ws.close();
stop();
await sleep(500);
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(0);
