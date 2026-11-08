import express from 'express';
import config from '../config.js';
import logger from '../utils/logger.js';
import * as users from '../users/store.js';
import * as store from '../drive/store.js';
import { revokeMail } from '../auth/mail-access.js';
import { clearSessionCookie } from '../auth/session.js';
import { clearUnlockCookie } from '../auth/pin.js';
import { lastSyncAt, isPolling } from '../poll.js';
import { billingSummary, LIVE_STATUSES } from '../billing/entitlement.js';
import { cancelSubscription } from '../billing/razorpay.js';
import { settingsOf } from './data.js';

const router = express.Router();

/**
 * Who is signed in, plus the few facts the app shell needs on every screen:
 * billing and trial state, when email was last checked, how far onboarding has
 * got, where the ledger lives in Drive, and the account's settings.
 *
 * Reachable past the paywall, which needs the billing state and the Drive link.
 */
router.get('/me', async (req, res, next) => {
  try {
    const account = req.account;
    const db = await store.init();
    // Null with billing off: no trial, no plan, no screens about either.
    const billing = config.features.billing ? billingSummary(account, { trialDays: config.trial.days }) : null;

    res.json({
      email: account.email,
      name: account.name || null,
      createdAt: account.createdAt || null,
      trialEndsAt: billing?.trialEndsAt ?? null,
      trialDaysLeft: billing?.trialDaysLeft ?? null,
      billing,
      lastSyncAt: lastSyncAt(account.id, db),
      syncing: isPolling(account.id),
      pollMinutes: 10,
      firstSyncAt: db.meta?.firstSyncAt || null,
      trialIntroAt: account.trialIntroAt || null,
      driveFileUrl: store.fileUrl(),
      settings: settingsOf(db),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Onboarding steps that happen once per account, whatever the device. Kept on
 * the account record: a timestamp, not ledger data.
 */
router.post('/onboarding/trial-intro', async (req, res, next) => {
  try {
    const account = req.account.trialIntroAt
      ? req.account
      : await users.saveUser(req.account.id, { trialIntroAt: new Date().toISOString() });
    res.json({ trialIntroAt: account.trialIntroAt });
  } catch (err) {
    next(err);
  }
});

/**
 * Deletes the account: revokes Google access and removes the server's record.
 *
 * The ledger file lives in the user's own Drive and belongs to them, so removing
 * it is an explicit choice (deleteDriveFile) rather than a side effect. Mounted
 * behind the PIN gate, so an unlocked phone in someone else's hand is not enough.
 *
 * A plan that can still charge is cancelled first. If Razorpay can't be reached
 * the account is kept and the error shown, so nobody goes on paying for an
 * account that no longer exists.
 */
router.delete('/account', async (req, res, next) => {
  try {
    const account = req.account;
    const removeFile = req.body?.deleteDriveFile === true;

    const billing = account.billing || {};
    if (billing.subscriptionId && LIVE_STATUSES.has(billing.status)) {
      await cancelSubscription(billing.subscriptionId);
      logger.info(`Billing: cancelled ${account.id}'s plan before deleting the account`);
    }

    if (removeFile) await store.deleteDataFile();
    await revokeMail(account);
    store.evictCurrentUser();
    await users.deleteUser(account.id);

    clearSessionCookie(res);
    clearUnlockCookie(res);
    logger.info(`Account deleted: ${account.id}${removeFile ? ' (Drive file removed)' : ''}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
