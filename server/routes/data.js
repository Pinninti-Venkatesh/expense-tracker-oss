import express from 'express';
import * as store from '../drive/store.js';
import { expensesToCsv } from '../csv.js';
import { today } from '../utils/datetime.js';

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Per-account preferences, kept in the account's own ledger file so they follow
 * the person across devices.
 *
 * settleEnabled: show the "To settle" tools for people who move every card
 * spend into a separate account. Off by default — most people don't.
 */
export const DEFAULT_SETTINGS = { settleEnabled: false };

export const settingsOf = (db) => ({ ...DEFAULT_SETTINGS, ...(db.settings || {}) });

router.get('/settings', asyncRoute(async (req, res) => {
  res.json(settingsOf(await store.init()));
}));

router.patch('/settings', asyncRoute(async (req, res) => {
  const patch = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in (req.body || {}))) continue;
    if (typeof req.body[key] !== typeof fallback) {
      return res.status(400).json({ error: `${key} must be a ${typeof fallback}` });
    }
    patch[key] = req.body[key];
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

  await store.mutate((d) => { d.settings = { ...settingsOf(d), ...patch }; });
  res.json(settingsOf(await store.init()));
}));

/** Every transaction as CSV. Behind the PIN gate like everything else. */
router.get('/export.csv', asyncRoute(async (req, res) => {
  const db = await store.init();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${today()}.csv"`);
  res.send(expensesToCsv(db.expenses));
}));

export default router;
