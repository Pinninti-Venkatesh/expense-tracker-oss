import express from 'express';
import logger from '../utils/logger.js';
import * as store from '../drive/store.js';
import { setSessionCookie } from '../auth/session.js';
import {
  isPinSet, isUnlocked, attemptPin, setPin, removePin, validatePinFormat,
  setUnlockCookie, clearUnlockCookie, lockoutRemaining, limits,
} from '../auth/pin.js';

const router = express.Router();

/**
 * PIN routes sit between requireAuth and requirePin: you must be signed in to
 * reach them, but not unlocked — otherwise there would be no way to unlock.
 * Every route that changes the PIN therefore checks the current one itself.
 *
 * A rejected PIN answers 403, never 401: the client treats 401 as a dead
 * session and redirects to Google, which would throw you out of the app for
 * fat-fingering a digit.
 */

const seconds = (ms) => Math.ceil(ms / 1000);

// A fresh Google sign-in proves who is holding the device, so it can replace a
// forgotten PIN. The proof is short-lived and burned on use.
const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const recentlyReauthenticated = (req) => {
  const at = Number(req.session?.reauthAt);
  return Boolean(at) && Date.now() - at <= REAUTH_WINDOW_MS;
};

const tooMany = (res, retryAfterMs, wrongMessage) => res.status(retryAfterMs ? 429 : 403).json({
  error: retryAfterMs
    ? `Too many attempts. Try again in ${Math.ceil(retryAfterMs / 60000)} minute(s).`
    : wrongMessage,
  lockedForSeconds: seconds(retryAfterMs),
});

// The PIN lives in the account's ledger file, so it has to be loaded first.
router.use('/pin', async (req, res, next) => {
  try {
    await store.init();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/pin/status', (req, res) => {
  res.json({
    enabled: isPinSet(),
    unlocked: isUnlocked(req),
    canReset: recentlyReauthenticated(req),
    lockedForSeconds: seconds(lockoutRemaining()),
    idleMinutes: Math.round(limits.IDLE_MS / 60000),
    minLength: limits.MIN_LENGTH,
    maxLength: limits.MAX_LENGTH,
  });
});

router.post('/pin/verify', async (req, res, next) => {
  try {
    if (!isPinSet()) return res.json({ ok: true, enabled: false });

    const { ok, retryAfterMs } = await attemptPin(req.body?.pin);
    if (!ok) {
      logger.warn(`Failed PIN attempt for ${req.user}`);
      return tooMany(res, retryAfterMs, 'Incorrect PIN.');
    }

    setUnlockCookie(req, res, req.user);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/pin/lock', (req, res) => {
  clearUnlockCookie(res);
  res.json({ ok: true });
});

/** Set a PIN, or change an existing one (which requires the current PIN). */
router.post('/pin', async (req, res, next) => {
  try {
    const { pin, currentPin } = req.body || {};

    const invalid = validatePinFormat(pin);
    if (invalid) return res.status(400).json({ error: invalid });

    if (isPinSet()) {
      const { ok, retryAfterMs } = await attemptPin(currentPin);
      if (!ok) return tooMany(res, retryAfterMs, 'Current PIN is incorrect.');
    }

    await setPin(pin);
    // Changing the PIN invalidates outstanding unlocks (they carry the old hash
    // version), so re-issue one for the browser doing the changing.
    setUnlockCookie(req, res, req.user);
    logger.info(`PIN set for ${req.user}`);
    res.json({ ok: true, enabled: true });
  } catch (err) { next(err); }
});

router.delete('/pin', async (req, res, next) => {
  try {
    if (!isPinSet()) return res.json({ ok: true, enabled: false });

    const { ok, retryAfterMs } = await attemptPin(req.body?.currentPin);
    if (!ok) return tooMany(res, retryAfterMs, 'Current PIN is incorrect.');

    await removePin();
    clearUnlockCookie(res);
    logger.info(`PIN removed for ${req.user}`);
    res.json({ ok: true, enabled: false });
  } catch (err) { next(err); }
});

/**
 * Replaces a forgotten PIN. Allowed only within minutes of signing in to Google
 * again with intent=pin-reset — the same proof the account was opened with, and
 * one that needs no permission to send email.
 */
router.post('/pin/reset', async (req, res, next) => {
  try {
    if (!recentlyReauthenticated(req)) {
      return res.status(403).json({
        error: 'Confirm it is you by signing in with Google again, then set a new PIN.',
        loginUrl: '/api/login?intent=pin-reset',
      });
    }

    const invalid = validatePinFormat(req.body?.pin);
    if (invalid) return res.status(400).json({ error: invalid });

    await setPin(req.body.pin);
    // Burn the proof, so the same sign-in can't reset the PIN a second time.
    setSessionCookie(req, res, { uid: req.session.uid, email: req.session.email });
    setUnlockCookie(req, res, req.user);
    logger.info(`PIN reset after Google re-authentication for ${req.user}`);
    res.json({ ok: true, enabled: true });
  } catch (err) { next(err); }
});

export default router;
