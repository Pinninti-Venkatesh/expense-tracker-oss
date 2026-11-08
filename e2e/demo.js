/**
 * The public demo: the real app, with fake Google, Gmail, Drive and Claude
 * (fakes.js), on one port so it can run on Cloud Run or anywhere else.
 *
 *   npm run demo            # http://localhost:8080
 *
 * Each visitor who "signs in" gets a private sandbox copy of a persona, with six
 * weeks of fake bank alerts, deleted after SANDBOX_TTL_MINUTES. Nothing real is
 * read, stored or sent anywhere, and no API key is needed.
 *
 * Layout: this process listens on PORT and serves the project website (site/)
 * and the fake sign-in page itself; everything else is proxied to the app,
 * which listens on a private port. `/` is the website until a visitor starts
 * the demo, and the app after that.
 *
 * SITE_GITHUB_URL and SITE_CONTACT fill the website's source link and contact line.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startApp } from './setup.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8080);
const APP_PORT = PORT + 1000;
const TTL_MS = Number(process.env.SANDBOX_TTL_MINUTES || 60) * 60 * 1000;
const MAX_SANDBOXES = Number(process.env.MAX_SANDBOXES || 200);
const CALLBACK = '/api/login/callback';

const { fakes } = await startApp({
  port: APP_PORT,
  hosted: false,
  keepData: false,
  env: {
    PRODUCT_NAME: 'Expenses demo',
    // The fake sign-in is served below, on the same origin, so both of these
    // are paths rather than another host.
    GOOGLE_REDIRECT_URI: CALLBACK,
    // There is no Google warning to walk anyone through.
    GOOGLE_APP_VERIFIED: 'true',
    MAX_USERS: String(MAX_SANDBOXES + 10),
    // Sandboxes are meant to vanish, so a disk Cloud Run wipes is fine here.
    EPHEMERAL_STORE: 'true',
  },
});
fakes.state.googleBase = '/__demo';
const users = await import('../server/users/store.js');
const { PERSONAS, sandboxPersona, staleSandboxes, sandboxCount, forgetSandbox } = fakes;

async function removeSandbox({ key, sub }) {
  await users.deleteUser(sub).catch(() => {});
  forgetSandbox(key);
}

// Old sandboxes are deleted, so the demo's memory stays bounded however many
// people try it.
setInterval(async () => {
  for (const sandbox of staleSandboxes(TTL_MS)) await removeSandbox(sandbox);
}, 5 * 60 * 1000).unref();

const escape = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const CHOICES = [
  { key: 'asha', blurb: 'HDFC credit card · the format the app learns fastest' },
  { key: 'nisha', blurb: 'ICICI credit card · a second bank layout' },
];

const front = express();
front.disable('x-powered-by');

/* ---------- the website ---------- */

const GITHUB_URL = process.env.SITE_GITHUB_URL || 'https://github.com/Pinninti-Venkatesh/expense-tracker-oss';
const CONTACT = process.env.SITE_CONTACT
  ? (process.env.SITE_CONTACT.includes('@')
    ? `<a href="mailto:${escape(process.env.SITE_CONTACT)}">${escape(process.env.SITE_CONTACT)}</a>`
    : escape(process.env.SITE_CONTACT))
  : `open an issue on the <a href="${escape(GITHUB_URL)}">project's source repository</a>`;

/** A page from site/, with its placeholders filled. Read once. */
const pages = new Map();
function sitePage(name) {
  if (!pages.has(name)) {
    const html = fs.readFileSync(path.join(root, 'site', name), 'utf8')
      .replaceAll('{{GITHUB_URL}}', escape(GITHUB_URL))
      .replaceAll('{{CONTACT}}', CONTACT);
    pages.set(name, html);
  }
  return pages.get(name);
}

const SITE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const sendPage = (res, name) => res.set('Content-Security-Policy', SITE_CSP).set('X-Content-Type-Options', 'nosniff').type('html').send(sitePage(name));

// A visitor with a demo session is sent on to the app; everyone else sees the site.
const inDemo = (req) => /(?:^|;\s*)et_session=/.test(req.headers.cookie || '');

front.get('/', (req, res, next) => (inDemo(req) ? next() : sendPage(res, 'index.html')));
front.get('/privacy', (req, res) => sendPage(res, 'privacy.html'));
front.get('/demo', (req, res) => res.redirect('/api/login'));
front.use('/site/screenshots', express.static(path.join(root, 'docs', 'screenshots'), { maxAge: '1d' }));
front.use('/site', express.static(path.join(root, 'site'), { maxAge: '1d', index: false }));

/* ---------- the demo ---------- */

// The stand-in for Google's account chooser.
front.get('/__demo/auth', (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).send('Missing state');
  const rows = CHOICES.map(({ key, blurb }) => `
    <a class="row" href="/__demo/start?${new URLSearchParams({ as: key, state })}">
      <b>${escape(PERSONAS[key].name)}</b><small>${escape(blurb)}</small>
    </a>`).join('');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Try the demo</title>
    <style>body{font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#eef3f8;padding:16px;color:#1c2733}
    main{background:#fff;border-radius:14px;padding:24px;max-width:440px;width:100%;box-shadow:0 1px 3px #0002}
    h1{font-size:21px;font-weight:600;margin:0 0 6px}p{color:#51606f;margin:0 0 16px;line-height:1.45}
    .row{display:grid;gap:2px;padding:14px 12px;border-top:1px solid #e6ebf0;color:inherit;text-decoration:none}
    .row:hover{background:#f5f8fb}small{color:#51606f}</style>
    <main><h1>Pick someone to be</h1>
    <p>This is a demo with made-up bank alerts. You get your own private copy, deleted after an hour. No Google account is used and nothing leaves this server.</p>
    ${rows}</main>`);
});

// Makes the visitor's sandbox and "returns from Google" with it.
front.get('/__demo/start', async (req, res) => {
  const { as, state } = req.query;
  if (!CHOICES.some((c) => c.key === as) || !state) return res.redirect('/');
  if (sandboxCount() >= MAX_SANDBOXES) await removeSandbox(staleSandboxes(0)[0]);
  const persona = sandboxPersona(as);
  const key = persona.sub.replace(/^g-/, '');
  res.redirect(`${CALLBACK}?${new URLSearchParams({ state, code: `persona:${key}` })}`);
});

// Everything else is the app.
front.use((req, res) => {
  const upstream = http.request({
    host: '127.0.0.1',
    port: APP_PORT,
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
  }, (reply) => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).send('The demo is starting. Try again in a moment.');
    else res.end();
  });
  req.pipe(upstream);
});

front.listen(PORT, () => console.log(`Demo: http://localhost:${PORT}`));
