import express from 'express';
import crypto from 'node:crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import * as users from '../users/store.js';
import { prepareMail, isAccessRevoked } from '../auth/mail-access.js';
import { runAsUser } from '../context.js';
import { poll } from '../poll.js';
import { checkStatementsAutomatically } from '../upi/statement.js';
import { isEntitled } from '../billing/entitlement.js';

const router = express.Router();

/**
 * Cloud Scheduler cannot present a session cookie, so the routine poll has its
 * own door. It is a shared secret rather than an open endpoint: this route is
 * mounted ahead of requireAuth, so without the check anyone on the internet
 * could drive Gmail reads and model spend for every account.
 */
function authorised(req) {
  const expected = config.cron.secret;
  if (!expected) return false; // unset = the endpoint is closed, not open

  const given = Buffer.from(String(req.get('X-Cron-Key') || ''));
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** Runs worker over items with at most `limit` in flight. */
async function eachWithLimit(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Polls every account, a few at a time, and returns a summary. Shared by the
 * scheduled request (Cloud Run) and the built-in timer (a server or Docker).
 */
export async function pollAllAccounts() {
  const started = Date.now();
  const pollable = await users.listPollableUsers();
  // With billing on, an account past its trial or paid days sees only the
  // subscribe screen, so reading its email would spend Gmail quota and model
  // calls on nobody.
  const accounts = config.features.billing
    ? pollable.filter((a) => isEntitled(a, { trialDays: config.trial.days }))
    : pollable;
  const summary = { accounts: accounts.length, unpaid: pollable.length - accounts.length, ok: 0, failed: 0, needsReauth: 0, skipped: 0, added: 0 };

  await eachWithLimit(accounts, config.poll.concurrency, async (account) => {
    try {
      await prepareMail(account);
      const result = await runAsUser(account, async () => {
        const polled = await poll({ label: 'cron' });
        // With a statement password kept (UPI_STATEMENT_PASSWORD), new statements too.
        if (!polled.skipped && !polled.error) {
          const statements = await checkStatementsAutomatically();
          if (statements?.added) polled.added = (polled.added || 0) + statements.added;
        }
        return polled;
      });

      if (result.skipped) {
        summary.skipped++;
      } else if (result.error) {
        summary.failed++;
        if (isAccessRevoked(result.error)) {
          // Access revoked or expired. Stop polling until they sign in again —
          // retrying every ten minutes would only fail the same way.
          summary.needsReauth++;
          await users.saveUser(account.id, { needsReauth: true, lastPollError: 'Gmail access revoked or expired' });
        } else {
          await users.saveUser(account.id, { lastPollError: String(result.error).slice(0, 300) });
        }
      } else {
        summary.ok++;
        summary.added += result.added || 0;
        // Only write when clearing an old error, not on every healthy tick.
        if (account.lastPollError) await users.saveUser(account.id, { lastPollError: null });
      }
    } catch (err) {
      summary.failed++;
      logger.error(`Poll failed for ${account.id}`, err.message);
    }
  });

  summary.ms = Date.now() - started;
  logger.info('cron complete', summary);
  return summary;
}

/**
 * One scheduled request polls every account. Never one request per account:
 * Cloud Run bills for the time a request is open, so fanning out inside a single
 * request costs the same as one user's poll plus the Gmail round-trips, however
 * many accounts there are.
 */
router.post('/cron/poll', async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ error: 'Unauthorised' });

  try {
    const summary = await pollAllAccounts();
    // Scheduler should record a failure only when the job as a whole is broken.
    // One user revoking access is routine, not an outage.
    const systemic = summary.accounts > 0 && summary.ok === 0 && summary.failed > summary.needsReauth;
    res.status(systemic ? 500 : 200).json(summary);
  } catch (err) {
    logger.error('Scheduled poll failed', err.message);
    res.status(500).json({ error: 'Scheduled poll failed' });
  }
});

/**
 * Polls on a timer inside the process (POLL_INTERVAL_MINUTES), for a server or
 * Docker host that stays up. Not for Cloud Run, which stops the process between
 * requests: use Cloud Scheduler there. A run still going when the next is due
 * is left to finish rather than doubled up.
 */
export function startPollTimer(minutes = config.poll.intervalMinutes) {
  if (!minutes) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollAllAccounts();
    } catch (err) {
      logger.error('Timed poll failed', err.message);
    } finally {
      running = false;
    }
  };
  logger.info(`Checking every account's email every ${minutes} minute(s)`);
  return setInterval(tick, minutes * 60 * 1000);
}

export default router;
