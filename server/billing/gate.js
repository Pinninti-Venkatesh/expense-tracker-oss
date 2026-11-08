import config from '../config.js';
import logger from '../utils/logger.js';
import * as users from '../users/store.js';
import * as store from '../drive/store.js';
import { isEntitled } from './entitlement.js';

/**
 * The paywall. Mounted after the PIN gate, in front of every data route.
 *
 * When the trial or the paid days run out, the app shows only the subscribe
 * screen. What stays reachable is what that screen needs, plus the ways out a
 * customer is always owed: their data as CSV, and deleting the account.
 * Checking email stops too, since the scheduled poll skips these accounts.
 *
 * 402 Payment Required, distinct from 401 (sign in) and 423 (PIN), so the app
 * knows which screen to show.
 */
const OPEN = [
  /^\/me$/,
  /^\/billing(\/|$)/,
  /^\/onboarding(\/|$)/,
  /^\/export\.csv$/,
  /^\/account$/,
];

export async function requireEntitlement(req, res, next) {
  // Self-hosted: nothing to pay for, nothing to lock.
  if (!config.features.billing) return next();
  try {
    const account = req.account;
    const open = OPEN.some((pattern) => pattern.test(req.path));

    if (!isEntitled(account, { trialDays: config.trial.days })) {
      // Noted once, so the account can catch up when it comes back.
      if (!account.pausedForPaymentAt) await users.saveUser(account.id, { pausedForPaymentAt: new Date().toISOString() });
      if (open) return next();
      return res.status(402).json({ error: 'Subscribe to keep using the app.', paymentRequired: true });
    }

    // Back after the paywall. Alerts from the locked days were never read, and
    // the routine poll only looks back a day. Clearing firstSyncAt makes the app
    // run the first sync again: it re-reads from the 1st of last month and skips
    // every email it already has, so only the missed ones cost anything.
    if (account.pausedForPaymentAt) {
      await store.mutate((d) => {
        d.meta ||= {};
        d.meta.firstSyncAt = null;
      });
      await users.saveUser(account.id, { pausedForPaymentAt: null });
      logger.info(`Billing: ${account.id} is back after the paywall; catching up`);
    }
    next();
  } catch (err) {
    next(err);
  }
}
