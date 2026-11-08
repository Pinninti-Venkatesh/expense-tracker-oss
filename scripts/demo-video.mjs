/**
 * Records the website's demo video from the local mock: a fresh install set up
 * in the browser, then the app in use. Fake inbox, fake Gmail, fake Claude: no
 * real data can end up in it.
 *
 *   npm --prefix web run build && node scripts/demo-video.mjs
 *
 * Needs only Google Chrome. Headless Chrome takes screenshots of the page as
 * fast as it can (at phone resolution, 2x) while a script plays the scenes; a
 * second page then encodes them to H.264 with WebCodecs, at a steady 30 frames
 * a second and each screen held as long as it was on screen, and mp4-muxer
 * writes the MP4. Writes site/media/demo.mp4 and site/media/demo-poster.jpg.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'site', 'media');
// A port of its own, clear of a copy of the app you may be running on 8080.
const PORT = Number(process.env.DEMO_PORT || 8090);
const ADMIN = PORT + 1;
const DEVTOOLS = 18710;
const ENCODER = 18720;
const base = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHONE = { width: 390, height: 844 };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const children = [];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-'));
const frameDir = path.join(work, 'frames');
fs.mkdirSync(frameDir);
const stop = () => children.forEach((c) => c.kill());
process.on('exit', stop);

async function waitFor(url, what) {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`${what} did not start`);
}

/* ---------- 1. a fresh simple-path install, from the mock ---------- */

const mock = spawn(process.execPath, ['--experimental-test-module-mocks', path.join(root, 'e2e', 'serve.js')], {
  env: { ...process.env, MOCK_MAIL: 'app-password', E2E_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
children.push(mock);
let mockLog = '';
mock.stdout.on('data', (d) => { mockLog += d; });
await waitFor(`${base}/api/health`, 'The mock');
for (let i = 0; i < 100 && !/Setup code:\s+\d{4}-\d{4}/.test(mockLog); i++) await sleep(100);
const setupCode = /Setup code:\s+(\d{4}-\d{4})/.exec(mockLog)?.[1];
if (!setupCode) throw new Error('The mock did not print a setup code');
const appPassword = /asha\.rao@gmail\.com\s+(\w{16})/.exec(mockLog)?.[1];

/* ---------- 2. headless Chrome over the DevTools protocol ---------- */

const profile = path.join(work, 'chrome');
children.push(spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEVTOOLS}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' }));
await waitFor(`http://127.0.0.1:${DEVTOOLS}/json/version`, 'Chrome');

async function connect(url) {
  const target = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/new?${url}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => { ws.onopen = resolve; });
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method && listeners.has(msg.method)) {
      listeners.get(msg.method)(msg.params);
    }
  };
  // A command sent while the page reloads can go unanswered; never wait forever.
  const send = (method, params = {}, { timeout = 10000 } = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: no answer`));
    }, timeout);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, on: (method, fn) => listeners.set(method, fn), close: () => ws.close(), id: target.id };
}

const page = await connect('about:blank');
const { send } = page;
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { ...PHONE, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeout: 4000 })).result?.value;

/** Waits until `expression` is truthy in the page. */
async function until(expression, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const hasText = (text) => `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;

/** Clicks the button or link whose text (or a settings row's title) is `text`. */
async function click(text) {
  const ok = await evaluate(`(() => {
    const want = ${JSON.stringify(text)};
    const el = [...document.querySelectorAll('button, a')]
      .find((e) => e.textContent.trim() === want || e.querySelector('b')?.textContent.trim() === want);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => el.click(), 350);
    return true;
  })()`);
  if (!ok) throw new Error(`No "${text}" to click`);
  await sleep(700);
}

/** Types into the field labelled `label`, a key at a time, as a person would. */
async function type(selector, text, { perKey = 55 } = {}) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  for (const ch of text) {
    await send('Input.insertText', { text: ch });
    await sleep(perKey);
  }
  await sleep(250);
}

/* ---------- captions ---------- */

let currentCaption = '';
// Above the bottom bar in the app; lower on the setup screens, which have none.
let captionBottom = 20;
async function caption(text) {
  currentCaption = text;
  await evaluate(`(() => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.style.cssText = 'position:fixed;left:14px;right:14px;bottom:${captionBottom}px;z-index:99999;padding:11px 14px;border-radius:14px;'
        + 'background:#0b1a2e;color:#fff;font:600 15px/1.35 Rubik,system-ui,sans-serif;text-align:center;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.25);transition:opacity .35s ease,transform .35s ease;pointer-events:none';
      document.body.appendChild(el);
    }
    el.style.bottom = '${captionBottom}px';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => { el.textContent = ${JSON.stringify(text)}; el.style.opacity = '${text ? 1 : 0}'; el.style.transform = 'none'; }, 180);
  })()`);
  await sleep(400);
}

/** After a full page load the overlay is gone; put the current caption back. */
const recaption = () => caption(currentCaption);

/* ---------- recording ---------- */

// Screenshots rather than a screencast: headless Chrome streams screencast
// frames at the page's CSS size, which looks soft on a phone.
const frames = []; // { name, ts (seconds), cutBefore }
let recording = false;
let cutPending = false;
let capturing = true;
const captureLoop = (async () => {
  while (capturing) {
    if (!recording) {
      await sleep(25);
      continue;
    }
    const at = Date.now();
    let data;
    try {
      ({ data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82, optimizeForSpeed: true }, { timeout: 3000 }));
    } catch {
      continue; // mid-reload: the next one will do
    }
    if (!recording) continue;
    const name = `${String(frames.length).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(frameDir, name), Buffer.from(data, 'base64'));
    frames.push({ name, ts: at / 1000, cutBefore: cutPending });
    cutPending = false;
  }
})();

const roll = () => { recording = true; };
const cut = () => { recording = false; cutPending = true; };

/** Keeps the screen still for a while, on camera. */
const hold = (ms) => sleep(ms);

/* ---------- 3. the scenes ---------- */

await send('Page.navigate', { url: `${base}/` });
await until(hasText('Setup code'), 'the first-run screen');
await sleep(800);
roll();
await caption('Start it anywhere, then set it up in the browser');
await hold(1600);
await type('#setup-code', setupCode, { perKey: 90 });
await click('Continue');
await until(hasText('Connect Claude'), 'the Claude step');
await caption('Your Claude key, checked on the spot');
await hold(900);
await type('#setup-key', 'sk-ant-api03-good-demo-key-2026', { perKey: 30 });
await click('Continue');
await until(hasText('Connect your Gmail'), 'the Gmail step');
await caption('Your Gmail, with an app password. No Google Cloud.');
await hold(1200);
await type('#signin-email', 'asha.rao@gmail.com', { perKey: 40 });
await type('#signin-app-password', appPassword, { perKey: 35 });
await type('#signin-name', 'Asha Rao', { perKey: 60 });
await click('Finish setup');
// The page reloads into the first sync: the caption overlay goes with the old page.
await until('!document.getElementById("demo-caption") && document.readyState === "complete"', 'the reload');
await caption('Reading last month\'s alerts…');
await until(hasText('Spent so far'), 'Home after the first sync', 30000);
captionBottom = 96;
await recaption();
await caption('Last month\'s alerts, read and filed by itself');
await hold(2600);

// Off camera: a loan and two IOUs, so every screen has something on it.
cut();
const today = new Date();
const monthsAgo = (n) => new Date(today.getFullYear(), today.getMonth() - n, 5).toISOString().slice(0, 10);
await evaluate(`Promise.all([
  fetch('/api/loans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Car loan', type: 'car', principal: 850000, annualRate: 9.1, tenureMonths: 60, startDate: '${monthsAgo(14)}' }) }),
  fetch('/api/ledger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'lent', personName: 'Rohan', amount: 2400, note: 'Concert tickets' }) }),
  fetch('/api/ledger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'borrowed', personName: 'Priya', amount: 650, note: 'Cab to the airport' }) }),
]).then((r) => r.map((x) => x.status))`);
await send('Page.reload');
await until(hasText('Spent so far'), 'Home again');
await sleep(1200);
roll();

// A new alert arrives.
await caption('A new card or UPI alert? It shows up on its own.');
await hold(900);
await fetch(`http://localhost:${ADMIN}/admin/mail/asha?amount=349&merchant=${encodeURIComponent('SWIGGY BANGALORE IN')}`);
await evaluate('document.querySelector(\'button[title="Check email now"]\')?.click()');
await until(hasText('new spend'), 'the new spend', 15000);
await hold(2600);

await click('Spends');
await caption('Every spend, by day');
await hold(2800);

await click('People');
await caption('Who owes whom, one balance each');
await hold(2600);

await click('Loans');
await caption('Loans that add up, and when they end');
await hold(2800);

await click('Home');
await sleep(600);
await evaluate('document.querySelector(".me-btn")?.click()');
await until(hasText('Household'), 'the You screen');
await caption('Invite your household with a one-time link');
await hold(900);
await click('Household');
await until(hasText('Make an invite link'), 'the Household screen');
await hold(1000);
await click('Make an invite link');
await until(hasText('Works once, for 7 days'), 'the invite link');
await hold(2400);

await click('Back up everything');
await caption('Back up everything in one file. Move it anywhere.');
await hold(2600);

await click('Home');
await until(hasText('Spent so far'), 'Home at the end');
await caption('Open source · self-hosted · yours');
await hold(2600);
cut();
capturing = false;
await captureLoop;
page.close();

/* ---------- 4. frames to video, in Chrome ---------- */

// Real timing between frames, with any off-camera gap cut short and very long
// holds trimmed.
const timeline = frames.map((f, i) => {
  const next = frames[i + 1];
  let ms = next ? (next.ts - f.ts) * 1000 : 1500;
  if (next?.cutBefore) ms = 250;
  return { name: f.name, ms: Math.max(16, Math.min(ms, 4000)) };
});
const total = timeline.reduce((s, f) => s + f.ms, 0);
console.log(`${frames.length} frames, ${(total / 1000).toFixed(1)} s`);

const encoderHtml = `<!doctype html><html><body>
<script src="/mp4-muxer.js"></script>
<script>
// Each source frame is held for exactly its time on screen, at a steady 30
// frames a second. A frame repeated while nothing changes costs next to nothing.
window.encode = async (timeline) => {
  const decode = async (name) => createImageBitmap(await (await fetch('/frames/' + name)).blob());
  const first = await decode(timeline[0].name);
  const width = first.width - (first.width % 2);
  const height = first.height - (first.height % 2);
  const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: 'avc', width, height }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  let config = null;
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42E028']) {
    const candidate = { codec, width, height, bitrate: 1_300_000, framerate: 30, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; }
  }
  if (!config) throw new Error('No H.264 encoder in this Chrome');
  encoder.configure(config);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const step = 1e6 / 30;
  let t = 0;
  let n = 0;
  // Where each source frame ends on the video's clock. Kept apart from t, so a
  // frame shorter than a video frame is skipped instead of stretching the rest.
  let end = 0;
  let bitmap = first;
  for (let i = 0; i < timeline.length; i++) {
    if (i > 0) bitmap = await decode(timeline[i].name);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    end += timeline[i].ms * 1000;
    while (t < end) {
      const frame = new VideoFrame(canvas, { timestamp: Math.round(t), duration: Math.round(step) });
      encoder.encode(frame, { keyFrame: n % 60 === 0 });
      frame.close();
      n += 1;
      t += step;
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      if (failure) throw failure;
    }
  }
  await encoder.flush();
  muxer.finalize();
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  await fetch('/upload?type=' + encodeURIComponent(config.codec), { method: 'POST', body: blob });
  return { codec: config.codec, frames: n, seconds: t / 1e6, size: blob.size };
};
</script></body></html>`;

let uploaded = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${ENCODER}`);
  if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(encoderHtml);
  if (url.pathname === '/mp4-muxer.js') {
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(fs.readFileSync(path.join(root, 'node_modules', 'mp4-muxer', 'build', 'mp4-muxer.js')));
  }
  if (url.pathname.startsWith('/frames/')) {
    const file = path.join(frameDir, path.basename(url.pathname));
    return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(fs.readFileSync(file));
  }
  if (url.pathname === '/upload' && req.method === 'POST') {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      uploaded = { type: url.searchParams.get('type'), body: Buffer.concat(parts) };
      res.writeHead(200).end('ok');
    });
    return undefined;
  }
  return res.writeHead(404).end();
});
await new Promise((resolve) => { server.listen(ENCODER, resolve); });

const encoder = await connect(`http://localhost:${ENCODER}/`);
await encoder.send('Runtime.enable');
await sleep(800);
console.log('Encoding…');
const result = await encoder.send('Runtime.evaluate', {
  expression: `window.encode(${JSON.stringify(timeline)})`, awaitPromise: true, returnByValue: true, timeout: total + 120000,
});
if (result.exceptionDetails || !uploaded) throw new Error(`Encoding failed: ${JSON.stringify(result.exceptionDetails || result.result)}`);

fs.mkdirSync(out, { recursive: true });
const ext = 'mp4';
fs.writeFileSync(path.join(out, 'demo.mp4'), uploaded.body);
// The poster: Home with spends on it, just before the new alert arrives.
const posterIndex = Math.max(0, frames.findIndex((f) => f.cutBefore) - 1);
fs.copyFileSync(path.join(frameDir, frames[posterIndex]?.name || frames[0].name), path.join(out, 'demo-poster.jpg'));
console.log(`site/media/demo.${ext} (${(uploaded.body.length / 1e6).toFixed(1)} MB, ${uploaded.type}, ${result.result.value.seconds.toFixed(1)} s) and site/media/demo-poster.jpg`);

encoder.close();
server.close();
stop();
await sleep(500);
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(0);
