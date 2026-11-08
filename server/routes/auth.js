import express from 'express';
import crypto from 'node:crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getAuthUrl, exchangeCode, hasRequiredScopes, forgetClient } from '../auth/google-auth.js';
import { runAsUser } from '../context.js';
import * as store from '../drive/store.js';
import { setSessionCookie, clearSessionCookie, readCookie, isAllowed } from '../auth/session.js';
import { clearUnlockCookie } from '../auth/pin.js';
import * as users from '../users/store.js';
import { encrypt } from '../users/secrets.js';
import { verifyAppPassword } from '../gmail/imap.js';
import { forgetMail, prepareMail } from '../auth/mail-access.js';
import * as install from '../install.js';

const router = express.Router();

/**
 * Sign-in and Google access are one step. The consent screen asks for identity
 * plus read-only Gmail and the app's own Drive file; the callback creates or
 * updates the account and stores its refresh token, encrypted.
 *
 * Intents:
 *   signin     — the normal path.
 *   reconnect  — forces Google's consent screen, to be handed a fresh refresh
 *                token after access was revoked or never fully granted.
 *   pin-reset  — a fresh sign-in as proof of identity, used instead of an
 *                emailed code to replace a forgotten PIN.
 */
const INTENTS = new Set(['signin', 'reconnect', 'pin-reset']);

// State lives in a short-lived cookie rather than server memory so it survives
// a Cloud Run cold start between the redirect out and the callback.
const STATE_COOKIE = 'et_oauth_state';

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f5f3;color:#0b0b0b;padding:24px}
main{max-width:34rem}h1{font-size:22px;margin:0 0 8px}p{color:#52514e}a{color:#2268c4}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;

/**
 * Back after Gmail access stopped: alerts from the gap were never read, and the
 * routine poll only looks back a day. Clearing firstSyncAt makes the app run the
 * first sync again, which re-reads from the 1st of last month and skips every
 * email it already has, so only the missed ones cost anything.
 */
async function catchUpAfterReconnect(account) {
  try {
    await prepareMail(account);
    await runAsUser(account, () => store.mutate((d) => {
      d.meta ||= {};
      d.meta.firstSyncAt = null;
    }));
  } catch (err) {
    logger.warn('Could not schedule a catch-up after reconnecting', err.message);
  }
}

router.get('/login', (req, res) => {
  const intent = INTENTS.has(req.query.intent) ? req.query.intent : 'signin';
  // App-password installs sign in on the app's own screen, not at Google.
  if (config.mail.access === 'app-password') return res.redirect(`/signin?intent=${intent}`);
  const state = crypto.randomBytes(16).toString('hex');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';

  res.append('Set-Cookie', `${STATE_COOKIE}=${state}.${intent}; Path=/api/login; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
  res.redirect(getAuthUrl({ state, forceConsent: intent === 'reconnect' }));
});

router.get('/login/callback', async (req, res) => {
  res.append('Set-Cookie', `${STATE_COOKIE}=; Path=/api/login; HttpOnly; SameSite=Lax; Max-Age=0`);

  try {
    if (req.query.error) {
      return res.status(400).type('html').send(page('Sign-in cancelled',
        `<p>Google returned: ${escapeHtml(req.query.error)}.</p><p><a href="/">Back to the start</a></p>`));
    }

    const [expected, rawIntent] = String(readCookie(req, STATE_COOKIE) || '').split('.');
    const intent = INTENTS.has(rawIntent) ? rawIntent : 'signin';
    if (!req.query.state || !expected || req.query.state !== expected) {
      return res.status(400).type('html').send(page('Sign-in expired', '<p>That sign-in link is no longer valid.</p><p><a href="/api/login">Try again</a></p>'));
    }
    if (!req.query.code) return res.status(400).type('html').send(page('Sign-in failed', '<p>Google did not return an authorization code.</p>'));

    const { tokens, profile } = await exchangeCode(req.query.code);
    if (!profile.email || !profile.emailVerified) {
      return res.status(403).type('html').send(page('Email not verified', '<p>Your Google account needs a verified email address.</p>'));
    }
    if (!isAllowed(profile.email)) {
      logger.warn(`Denied sign-in for ${profile.sub}: not on the allowlist`);
      return res.status(403).type('html').send(page('Not on the list',
        '<p>This install only lets in the Google accounts its owner has listed. Ask them to add your email to <code>ALLOWED_EMAILS</code>.</p>'));
    }

    const existing = await users.getUser(profile.sub);
    if (!existing && config.users.maxUsers && (await users.countUsers()) >= config.users.maxUsers) {
      logger.warn(`Refused new account ${profile.sub}: user cap of ${config.users.maxUsers} reached`);
      return res.status(403).type('html').send(page('No places left',
        '<p>This install has reached its account limit (<code>MAX_USERS</code>).</p>'));
    }

    if (!hasRequiredScopes(tokens)) {
      return res.status(403).type('html').send(page('Access was not granted',
        '<p>The app needs both permissions on Google\'s consent screen: reading your Gmail (read-only) and its own file in your Drive. Without them it has nothing to read and nowhere to keep your ledger.</p>' +
        '<p><a href="/api/login?intent=reconnect">Try again and tick both boxes</a></p>'));
    }

    const now = new Date().toISOString();
    const patch = {
      email: profile.email.toLowerCase(),
      name: profile.name || null,
      status: existing?.status || 'active',
      lastLoginAt: now,
      ...(!existing && { createdAt: now }),
      // Which policy the account agreed to, when there is a policy to agree to.
      ...(!existing && config.features.legalPages && { consentAt: now, consentVersion: config.legal.policyVersion }),
    };
    if (tokens.refresh_token) {
      patch.encryptedRefreshToken = encrypt(tokens.refresh_token, profile.sub);
      patch.needsReauth = false;
      forgetClient(profile.sub);
    }
    const account = await users.saveUser(profile.sub, patch);

    if (account.status !== 'active') {
      return res.status(403).type('html').send(page('Account disabled', '<p>This account has been disabled. Contact support if you think that is a mistake.</p>'));
    }

    // Google only hands out a refresh token on a consent screen. A returning
    // user whose token is missing or dead gets sent round once more with consent
    // forced — but only once, so a refusal can never loop.
    if (!account.encryptedRefreshToken || account.needsReauth) {
      if (intent === 'reconnect') {
        return res.status(502).type('html').send(page('Could not connect Google', '<p>Google did not provide offline access. Please try again.</p><p><a href="/api/login?intent=reconnect">Try again</a></p>'));
      }
      return res.redirect('/api/login?intent=reconnect');
    }

    if (existing?.needsReauth) await catchUpAfterReconnect(account);

    setSessionCookie(req, res, {
      uid: account.id,
      email: account.email,
      ...(intent === 'pin-reset' && { reauthAt: Date.now() }),
    });
    logger.info(`Signed in: ${account.id}${existing ? '' : ' (new account)'}`);
    res.redirect(intent === 'pin-reset' ? '/?pinReset=1' : '/');
  } catch (err) {
    logger.error('Sign-in failed', err.message);
    res.status(500).type('html').send(page('Sign-in failed', '<p>Something went wrong talking to Google.</p><p><a href="/api/login">Try again</a></p>'));
  }
});

/* ---------- Gmail app password (MAIL_ACCESS=app-password) ---------- */

/**
 * Sign-in for installs without a Google Cloud project. Each person makes an app
 * password in their Google account and enters it here with their address. The
 * server proves both by signing in to Gmail with them, so a working app
 * password is the proof of identity, as Google's consent screen is otherwise.
 * It is stored encrypted, like a refresh token, and used only to read mail.
 *
 * Who may connect: the owner, once, on the first-run screen (routes/setup.js);
 * anyone holding an unused invite link; anyone already a member; and anyone in
 * ALLOWED_EMAILS, for installs that list their household there.
 */

// Each attempt is a real sign-in at Gmail. A small budget per address and per
// browser keeps this from becoming a way to hammer Google with guesses.
const ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map(); // key -> [timestamps]

export function overBudget(...keys) {
  const now = Date.now();
  let over = false;
  for (const key of keys) {
    const recent = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= ATTEMPTS) over = true;
    recent.push(now);
    attempts.set(key, recent);
  }
  if (attempts.size > 5000) attempts.clear();
  return over;
}

export const appPasswordAccountId = (email) =>
  `gm-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 24)}`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The sign-in form, checked for shape before anyone talks to Gmail. */
export function parseAppPasswordForm(body = {}) {
  const intent = INTENTS.has(body.intent) ? body.intent : 'signin';
  const email = String(body.email || '').trim().toLowerCase();
  // Google shows it as four groups of four; the spaces are not part of it.
  const password = String(body.appPassword || '').replace(/\s+/g, '');
  const name = String(body.name || '').trim().slice(0, 80);
  if (!EMAIL.test(email)) return { error: 'Enter your Gmail address.', field: 'email' };
  if (!/^[a-z]{16}$/i.test(password)) {
    return { error: 'An app password is 16 letters, shown by Google in four groups of four.', field: 'appPassword' };
  }
  return { intent, email, password, name };
}

/**
 * Checks the app password with Gmail, then creates or updates the account and
 * signs this browser in. Answers the request either way. `afterSave` runs once
 * the account exists (setup uses it to record the owner).
 */
export async function connectAppPassword(req, res, form, { invite = null, afterSave = null, patch = {} } = {}) {
  const { intent, email, password, name } = form;
  if (overBudget(`ip:${req.ip}`, `email:${email}`)) {
    res.status(429).json({ error: 'Too many tries. Wait a few minutes, then try again.' });
    return { ok: false };
  }

  const id = appPasswordAccountId(email);
  const existing = await users.getUser(id);
  if (!existing && config.users.maxUsers && (await users.countUsers()) >= config.users.maxUsers) {
    res.status(403).json({ error: 'This install has reached its account limit (MAX_USERS).' });
    return { ok: false };
  }

  const check = await verifyAppPassword(email, password);
  if (!check.ok) {
    if (check.reason === 'auth') {
      res.status(400).json({
        error: 'Gmail didn\'t accept that address and app password together. Check the address, or make a new app password and paste it exactly.',
        field: 'appPassword',
      });
    } else {
      logger.warn('Could not reach Gmail to check an app password', check.message);
      res.status(502).json({ error: 'Couldn\'t reach Gmail just now. Check this computer\'s internet connection and try again.' });
    }
    return { ok: false };
  }

  try {
    const now = new Date().toISOString();
    const account = await users.saveUser(id, {
      email,
      name: name || existing?.name || null,
      status: 'active',
      lastLoginAt: now,
      ...(!existing && { createdAt: now }),
      ...(!existing && config.features.legalPages && { consentAt: now, consentVersion: config.legal.policyVersion }),
      encryptedAppPassword: encrypt(password, id),
      needsReauth: false,
      ...patch,
    });
    forgetMail(id);
    if (invite) install.useInvite(invite.id, id);
    if (afterSave) await afterSave(account);
    if (existing?.needsReauth) await catchUpAfterReconnect(account);

    setSessionCookie(req, res, {
      uid: account.id,
      email: account.email,
      ...(intent === 'pin-reset' && { reauthAt: Date.now() }),
    });
    logger.info(`Signed in with an app password: ${account.id}${existing ? '' : ' (new account)'}${invite ? ` via invite ${invite.id}` : ''}`);
    res.json({ ok: true, redirect: intent === 'pin-reset' ? '/?pinReset=1' : '/' });
    return { ok: true, account };
  } catch (err) {
    logger.error('App-password sign-in failed', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
    return { ok: false };
  }
}

router.post('/login/app-password', async (req, res) => {
  if (config.mail.access !== 'app-password') return res.status(404).json({ error: 'Not available on this install' });
  if (await install.setupNeeded()) {
    return res.status(409).json({ error: 'This app isn\'t set up yet. Open its address to set it up.' });
  }

  const form = parseAppPasswordForm(req.body);
  if (form.error) return res.status(400).json({ error: form.error, field: form.field });

  const existing = await users.getUser(appPasswordAccountId(form.email));
  const member = existing?.status === 'active';
  let invite = null;
  if (req.body?.invite) {
    invite = install.findInvite(String(req.body.invite));
    if (!invite && !member) {
      return res.status(400).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
    }
  }
  // Decided before Gmail is contacted, so this is never a way to test someone's password.
  if (!member && !invite && !config.users.allowlist.includes(form.email)) {
    logger.warn('Denied app-password sign-in: not a member and no invite');
    return res.status(403).json({
      error: existing
        ? 'Your access to this app was removed. Ask the person who set it up for a new invite link.'
        : 'This app only lets in people its owner has invited. Ask them for an invite link.',
      field: 'email',
    });
  }

  await connectAppPassword(req, res, form, { invite: member ? null : invite });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  clearUnlockCookie(res);
  res.json({ ok: true });
});

export default router;
