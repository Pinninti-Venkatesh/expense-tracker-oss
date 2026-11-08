import crypto from 'node:crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import * as users from '../users/store.js';
import { hasMailAccess, prepareMail } from './mail-access.js';
import { runAsUser } from '../context.js';

/**
 * Stateless signed sessions.
 *
 * Deliberately not a server-side session store: Cloud Run kills idle
 * containers, so in-memory sessions would log everyone out on every cold start.
 * The cookie carries a signed payload the server verifies on each request.
 *
 * The cookie only says which account this browser signed in as. What that
 * account may read is decided by its record in the user store on every request,
 * so disabling or deleting an account takes effect immediately.
 */

const COOKIE = 'et_session';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(data) {
  return crypto.createHmac('sha256', config.session.secret).update(data).digest();
}

/** claims: { uid, email, reauthAt? } */
export function issue(claims) {
  const payload = b64url(JSON.stringify({ ...claims, exp: Date.now() + MAX_AGE_MS }));
  return `${payload}.${b64url(hmac(payload))}`;
}

/** Returns the claims if the token is authentic and unexpired, else null. */
export function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.', 2);

  const expected = Buffer.from(b64url(hmac(payload)));
  const given = Buffer.from(sig || '');
  // Constant-time compare so the signature can't be brute-forced byte by byte.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!claims.uid || !claims.exp || Date.now() > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Minimal cookie parsing — avoids a dependency for one header. */
export function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const readSession = (req) => verify(readCookie(req));

const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

export function setSessionCookie(req, res, claims) {
  res.append('Set-Cookie', [
    `${COOKIE}=${encodeURIComponent(issue(claims))}`,
    'Path=/',
    'HttpOnly', // JS can't read it, so XSS can't steal it
    'SameSite=Lax', // blocks cross-site form/CSRF submissions
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
    ...(isSecure(req) ? ['Secure'] : []), // only omitted on plain-http localhost
  ].join('; '));
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * The household allowlist (ALLOWED_EMAILS). Empty means any Google account may
 * sign up, which production refuses unless OPEN_SIGNUP is set (config.js).
 */
export function isAllowed(email) {
  const list = config.users.allowlist;
  if (!list.length) return true;
  return list.includes(String(email || '').toLowerCase().trim());
}

/**
 * Gate for everything that touches data. Resolves the session to an account,
 * readies that account's Google client, and runs the rest of the request inside
 * the account's context — from here on, store and Gmail calls can only reach
 * this account's data.
 */
export async function requireAuth(req, res, next) {
  const session = readSession(req);
  const account = session ? await users.getUser(session.uid) : null;

  // On an app-password install membership is the account itself: the owner
  // invites and removes people in the app, not in ALLOWED_EMAILS.
  const listed = config.mail.access === 'app-password' || isAllowed(account?.email);
  if (!account || account.status !== 'active' || !listed) {
    if (session) clearSessionCookie(res);
    logger.warn(`Blocked unauthenticated ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Sign in required', loginUrl: '/api/login' });
  }

  if (account.needsReauth || !hasMailAccess(account)) {
    return res.status(401).json({
      error: config.mail.access === 'app-password' ? 'Gmail access needs to be reconnected' : 'Google access needs to be reconnected',
      loginUrl: '/api/login?intent=reconnect',
    });
  }

  await prepareMail(account);
  req.user = account.id;
  req.account = account;
  req.session = session;
  runAsUser(account, () => next());
}
