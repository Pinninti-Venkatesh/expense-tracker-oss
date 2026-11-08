import crypto from 'node:crypto';
import { promisify } from 'node:util';
import config from '../config.js';
import * as store from '../drive/store.js';

const scrypt = promisify(crypto.scrypt);

/**
 * A second lock, in front of the Google session.
 *
 * The session cookie answers "is this my Google account?" and lives for 30
 * days — which is the point, but it means an unlocked phone in someone else's
 * hand is an open ledger. The PIN answers a different question: "is the person
 * holding the device right now me?" It is deliberately short-lived and
 * server-enforced, so a locked app returns 423 for every data route rather than
 * relying on the frontend to hide anything.
 *
 * The PIN itself is never stored — only a scrypt hash, in the account's own
 * ledger file, so it follows the account rather than the device.
 */

const COOKIE = 'et_pin';
const MIN_LENGTH = 4;
const MAX_LENGTH = 12;

// How long an unlock lasts without activity. Every authorised request slides it.
const IDLE_MS = Math.max(1, config.pin.idleMinutes) * 60 * 1000;
const FREE_ATTEMPTS = 5;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/* ---------- storage ---------- */

const EMPTY_SECURITY = { pin: null, failed: { count: 0, lockedUntil: null } };

/** The security block of the account in context. Call store.init() first. */
function security() {
  const db = store.read();
  if (!db.security) db.security = { ...EMPTY_SECURITY };
  return db.security;
}

export function isPinSet() {
  return Boolean(security().pin?.hash);
}

async function hash(secret, salt) {
  return b64url(await scrypt(String(secret), salt, 64));
}

/** Constant-time compare of two base64url digests. */
function sameDigest(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/* ---------- unlock token ---------- */

function hmac(data) {
  return crypto.createHmac('sha256', config.session.secret).update(data).digest();
}

/**
 * Ties the unlock token to the current PIN hash, so changing or resetting the
 * PIN silently invalidates every unlock issued under the old one.
 */
function pinVersion() {
  const stored = security().pin;
  return stored ? b64url(hmac(stored.hash)).slice(0, 16) : 'none';
}

function issue(uid) {
  const payload = b64url(JSON.stringify({ uid, v: pinVersion(), exp: Date.now() + IDLE_MS }));
  return `${payload}.${b64url(hmac(payload))}`;
}

function verifyUnlockToken(token, uid) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.', 2);
  if (!sameDigest(sig, b64url(hmac(payload)))) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (claims.uid !== uid) return false;
    if (claims.v !== pinVersion()) return false;
    return Date.now() <= claims.exp;
  } catch {
    return false;
  }
}

export function setUnlockCookie(req, res, uid) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', [
    `${COOKIE}=${encodeURIComponent(issue(uid))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(IDLE_MS / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

export function clearUnlockCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ---------- lockout ---------- */

/** Remaining lockout in ms, or 0 when guessing is allowed. */
export function lockoutRemaining() {
  const until = security().failed?.lockedUntil;
  return until && until > Date.now() ? until - Date.now() : 0;
}

/**
 * Backs off exponentially once the free attempts are spent: 1, 2, 4 … capped at
 * 32 minutes. Persisted with the ledger rather than held in memory, so a cold
 * start isn't a way to clear the counter.
 */
async function recordFailure() {
  await store.mutate((db) => {
    const sec = (db.security ||= { ...EMPTY_SECURITY });
    const failed = (sec.failed ||= { count: 0, lockedUntil: null });
    failed.count = (failed.count || 0) + 1;
    if (failed.count >= FREE_ATTEMPTS) {
      const minutes = Math.min(2 ** (failed.count - FREE_ATTEMPTS), 32);
      failed.lockedUntil = Date.now() + minutes * 60 * 1000;
    }
  });
}

async function clearFailures() {
  await store.mutate((db) => {
    const sec = (db.security ||= { ...EMPTY_SECURITY });
    sec.failed = { count: 0, lockedUntil: null };
  });
}

/* ---------- pin lifecycle ---------- */

export function validatePinFormat(pin) {
  const value = String(pin ?? '');
  if (!/^\d+$/.test(value)) return 'PIN must be digits only.';
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) {
    return `PIN must be ${MIN_LENGTH}–${MAX_LENGTH} digits.`;
  }
  return null;
}

/** True when `pin` matches the stored one. Does not touch the failure counter. */
export async function checkPin(pin) {
  const stored = security().pin;
  if (!stored?.hash) return false;
  return sameDigest(await hash(pin, stored.salt), stored.hash);
}

/** Verifies a PIN attempt with lockout accounting: { ok } or { ok: false, retryAfterMs }. */
export async function attemptPin(pin) {
  const waiting = lockoutRemaining();
  if (waiting) return { ok: false, retryAfterMs: waiting };

  if (await checkPin(pin)) {
    if (security().failed?.count) await clearFailures();
    return { ok: true };
  }

  await recordFailure();
  return { ok: false, retryAfterMs: lockoutRemaining() };
}

export async function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = await hash(pin, salt);
  await store.mutate((db) => {
    const sec = (db.security ||= { ...EMPTY_SECURITY });
    sec.pin = { hash: digest, salt, updatedAt: new Date().toISOString() };
    sec.failed = { count: 0, lockedUntil: null };
    delete sec.reset;
  });
}

export async function removePin() {
  await store.mutate((db) => {
    const sec = (db.security ||= { ...EMPTY_SECURITY });
    sec.pin = null;
    sec.failed = { count: 0, lockedUntil: null };
  });
}

/* ---------- request gate ---------- */

/** True when this request carries a live unlock for the signed-in account. */
export function isUnlocked(req) {
  if (!isPinSet()) return true;
  const raw = readUnlockCookie(req);
  return Boolean(raw) && verifyUnlockToken(raw, req.user);
}

function readUnlockCookie(req) {
  const raw = req.headers.cookie
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`));
  return raw ? decodeURIComponent(raw.slice(COOKIE.length + 1)) : null;
}

/**
 * Gate for the data routes. Mounted after requireAuth, so the account context
 * is set. The ledger is loaded first on purpose: deciding "no PIN" from a file
 * that hasn't been read yet would wave every request through.
 *
 * 423 (Locked) rather than 401 keeps it distinct from "session expired" — the
 * frontend must show the keypad, not bounce to Google.
 */
export async function requirePin(req, res, next) {
  await store.init();
  if (!isPinSet()) return next();

  if (!isUnlocked(req)) {
    return res.status(423).json({ error: 'PIN required', pinRequired: true });
  }

  // Sliding window: activity keeps the app open, idleness locks it.
  setUnlockCookie(req, res, req.user);
  next();
}

export const limits = { MIN_LENGTH, MAX_LENGTH, IDLE_MS };
