import express from 'express';
import logger from '../utils/logger.js';
import * as store from '../drive/store.js';
import { effectiveAmount } from '../splits.js';

/**
 * Card-spend settling.
 *
 * Some people cover every credit-card charge by moving the same money to a
 * separate account, so they only spend what they actually hold. Marking a charge
 * "settled" records that the money has been moved.
 *
 * Only credit-card charges need this: UPI, debit and net banking leave the bank
 * directly. The amount to move is the net cost after splits and refunds.
 */
const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const round = (n) => Math.round(n * 100) / 100;

export const isSettleable = (e) => e.paymentType === 'Credit Card' && e.isExpense !== false;

/** What still has to be moved to the bank for this charge. */
export const settleAmount = (e) => Math.max(0, round(effectiveAmount(e)));

/** Outstanding: a card charge not yet settled that still costs something. */
export const needsSettling = (e) => isSettleable(e) && !e.settled && settleAmount(e) > 0.005;

router.post('/expenses/:id/settle', asyncRoute(async (req, res) => {
  const settled = Boolean(req.body?.settled);
  const db = await store.init();
  const expense = db.expenses.find((e) => e.id === req.params.id);
  if (!expense) return res.status(404).json({ error: 'No such expense' });

  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === req.params.id);
    target.settled = settled;
    target.settledAt = settled ? new Date().toISOString() : null;
  });

  res.json({ ok: true, settled });
}));

/** Settle every outstanding card charge in one go. */
router.post('/settle/all', asyncRoute(async (req, res) => {
  let count = 0;
  let total = 0;

  await store.mutate((d) => {
    const now = new Date().toISOString();
    for (const e of d.expenses) {
      if (needsSettling(e)) {
        e.settled = true;
        e.settledAt = now;
        count += 1;
        total += settleAmount(e);
      }
    }
  });

  total = round(total);
  logger.info(`Settled all: ${count} transaction(s)`);
  res.json({ ok: true, count, total });
}));

export default router;
