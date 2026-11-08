import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import config, { assertConfigured } from './config.js';
import logger from './utils/logger.js';
import { requireAuth, readSession } from './auth/session.js';
import { requirePin } from './auth/pin.js';
import { requireEntitlement } from './billing/gate.js';
import * as users from './users/store.js';
import { isAccessRevoked } from './auth/mail-access.js';
import * as install from './install.js';
import setup, { householdRouter } from './routes/setup.js';
import api from './routes/api.js';
import splits from './routes/splits.js';
import auth from './routes/auth.js';
import cron, { startPollTimer } from './routes/cron.js';
import ledger from './routes/ledger.js';
import settle from './routes/settle.js';
import upi from './routes/upi.js';
import loans from './routes/loans.js';
import pin from './routes/pin.js';
import account from './routes/account.js';
import data from './routes/data.js';
import billing, { handleWebhook } from './routes/billing.js';

const here = path.dirname(fileURLToPath(import.meta.url));

try {
  assertConfigured();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

const app = express();
// Cloud Run terminates TLS upstream; trust its header so req.secure is honest
// and cookies get the Secure flag in production.
app.set('trust proxy', 1);
app.disable('x-powered-by');

const { billing: billingOn, legalPages } = config.features;

// Razorpay signs the raw bytes of each webhook, so this route reads the body
// itself, ahead of the JSON parser, and ahead of sign-in: Razorpay has no session.
if (billingOn) app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), handleWebhook);

app.use(express.json({ limit: '100kb' }));

// Razorpay Checkout's script, the frame it opens and the calls it makes. Only
// allowed when payments are on; otherwise the page loads nothing third-party.
const razorpayCsp = billingOn
  ? { script: ' https://checkout.razorpay.com', frame: "frame-src https://api.razorpay.com https://checkout.razorpay.com", connect: ' https://api.razorpay.com https://lumberjack.razorpay.com' }
  : { script: '', frame: "frame-src 'none'", connect: '' };

app.use((req, res, next) => {
  // Defence in depth for pages that render financial data.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self'${razorpayCsp.script}`,
    razorpayCsp.frame,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${razorpayCsp.connect}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// --- public ------------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Whether this browser is signed in, and what the welcome screens need to say
// before it is. Nothing about any account.
app.get('/api/session', async (req, res) => res.json({
  signedIn: Boolean(readSession(req)),
  // An app-password install nobody has claimed yet shows its first-run screen.
  setup: { needed: await install.setupNeeded(), needsKey: install.needsClaudeKey() },
  product: config.product.name,
  // Which optional parts are switched on, so the screens only mention what exists.
  features: { billing: billingOn, legalPages, sharedTemplates: config.features.sharedTemplates },
  ...(billingOn && { trialDays: config.trial.days }),
  googleVerified: config.onboarding.googleVerified,
  // 'google' signs in at Google; 'app-password' on the app's own screen.
  mailAccess: config.mail.access,
  // So the screens name the model provider actually in use.
  ai: config.ai.vendor,
}));

app.use('/api', auth); // sign-in handshake
app.use('/api', setup); // first run (guarded by its one-time code) and reading invites
app.use('/api', cron); // carries its own shared-secret check

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** Fills a legal template. Unset values stay visible as [SET …] so a draft never passes for final. */
function renderLegal(file) {
  const values = {
    PRODUCT_NAME: config.product.name,
    OPERATOR_NAME: config.legal.operatorName,
    SUPPORT_EMAIL: config.product.supportEmail,
    EFFECTIVE_DATE: config.legal.effectiveDate,
    POLICY_VERSION: config.legal.policyVersion,
    TRIAL_DAYS: String(config.trial.days),
    MIN_ACCOUNTS: String(config.library.minContributors),
  };
  const template = fs.readFileSync(path.join(here, 'legal', file), 'utf8')
    // A line marked data-ai="…" belongs to one model provider. Keep the one in
    // use and drop the rest, so the policy can't describe a provider we never call.
    .replace(/^.*\bdata-ai="(\w+)".*\n?/gm, (line, provider) => (provider === config.ai.provider ? line : ''));
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (values[key] ? escapeHtml(values[key]) : `<mark>[SET ${key}]</mark>`));
}

if (legalPages) {
  app.get('/privacy', (req, res) => res.type('html').send(renderLegal('privacy.html')));
  app.get('/terms', (req, res) => res.type('html').send(renderLegal('terms.html')));
}

// --- signed in ---------------------------------------------------------------

// Everything below requires a valid session, and runs inside that account's
// context. Mounted before the data routes so no route can be reached by
// forgetting a guard.
app.use('/api', requireAuth);

// Signed in but not necessarily unlocked: these are how you unlock.
app.use('/api', pin);

// The second lock, in front of every data route.
app.use('/api', requirePin);

// Members, invites and the Claude key (app-password installs).
app.use('/api', householdRouter);

// The paywall, in front of every data route except the ones the subscribe
// screen needs (billing/gate.js). Passes everything through with billing off.
app.use('/api', requireEntitlement);

if (billingOn) app.use('/api', billing);
app.use('/api', api);
app.use('/api', splits);
app.use('/api', ledger);
app.use('/api', settle);
app.use('/api', upi);
app.use('/api', loans);
app.use('/api', account);
app.use('/api', data);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- the web app -------------------------------------------------------------

const webDist = path.join(here, '..', 'web', 'dist');

// The bundle holds no data, so it is served to everyone. Before sign-in the app
// shows its own welcome screens; every data route above still needs a session.
app.use(express.static(webDist, { index: false }));

app.get(/^(?!\/api\/).*/, (req, res) => {
  const index = path.join(webDist, 'index.html');
  if (!fs.existsSync(index)) return res.status(404).send('Frontend not built — run `npm run build` in web/.');
  res.sendFile(index);
});

// --- errors ------------------------------------------------------------------

app.use(async (err, req, res, next) => {
  logger.error(`${req.method} ${req.path}`, err.message);

  const googleRevoked = isAccessRevoked(err);
  const googleMissing = /Not authenticated with Google|Gmail access is not set up/i.test(err.message || '');
  if (googleRevoked && req.account) {
    await users.saveUser(req.account.id, { needsReauth: true }).catch(() => {});
  }
  if (googleRevoked || googleMissing) {
    return res.status(401).json({
      error: config.mail.access === 'app-password' ? 'Gmail access needs to be reconnected' : 'Google access needs to be reconnected',
      loginUrl: '/api/login?intent=reconnect',
    });
  }

  // Only errors raised on purpose (with a status) carry their message to the
  // browser; anything unexpected stays in the logs.
  const status = Number(err.status) || 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Something went wrong. Please try again.' });
});

install.load();

app.listen(config.server.port, async () => {
  startPollTimer();
  logger.info(`Listening on http://localhost:${config.server.port}`);
  if (await install.setupNeeded()) {
    // Where the person who started the app will look for it.
    logger.info(`Not set up yet. Open the app and enter this setup code: ${install.setupCode()}`);
  }
  const { allowlist, openSignup, maxUsers, backend } = config.users;
  const signUp = config.mail.access === 'app-password'
    ? `by invite${allowlist.length ? `, plus ${allowlist.length} listed in ALLOWED_EMAILS` : ''}`
    : allowlist.length ? `${allowlist.length} allowed account(s)` : openSignup ? 'open to anyone' : 'open (development only)';
  logger.info(`Email: ${config.mail.access === 'app-password' ? `Gmail app passwords; ledgers in ${config.ledger.dir}` : 'Google sign-in; ledgers in Drive'}`);
  logger.info(`Accounts: ${backend} store; ${signUp}${maxUsers ? `, capped at ${maxUsers}` : ''}`);
  const on = Object.entries(config.features).filter(([, v]) => v).map(([k]) => k);
  logger.info(`Optional features: ${on.length ? on.join(', ') : 'none (self-hosted)'}`);
  if (billingOn) logger.info(`Payments: ${config.billing.enabled ? `Razorpay (${config.billing.keyId.startsWith('rzp_test_') ? 'test mode' : 'live'})` : 'not configured'}`);
});
