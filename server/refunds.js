/**
 * Refunds against an existing expense. Manual by design for now — bank refund
 * emails are far less consistent than charge alerts, and a wrong auto-match
 * would silently understate your spending.
 *
 * Modelled as a list rather than a single amount because a partial refund can
 * arrive in instalments (one returned item now, another next week), and each
 * lands on its own date.
 */
import { today } from './utils/datetime.js';

export function newRefundId() {
  return `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export const refundedTotal = (expense) =>
  Math.round(
    (expense.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100,
  ) / 100;

/** Fully refunded means the charge cost you nothing — not that it never happened. */
export const isFullyRefunded = (expense) =>
  refundedTotal(expense) >= (Number(expense.amount) || 0) - 0.005;

export function validate(expense, amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error('Refund amount must be a positive number');
    err.status = 400;
    throw err;
  }

  // Guard against refunding more than was charged — almost always a typo, and
  // it would turn the expense into negative spending that skews every chart.
  const already = refundedTotal(expense);
  const charged = Number(expense.amount) || 0;
  if (already + value > charged + 0.005) {
    const err = new Error(
      `That would refund ${(already + value).toFixed(2)} against a ${charged.toFixed(2)} charge` +
      (already > 0 ? ` (${already.toFixed(2)} already refunded)` : ''),
    );
    err.status = 400;
    throw err;
  }

  return Math.round(value * 100) / 100;
}

export function buildRefund({ amount, date, note }) {
  return {
    id: newRefundId(),
    amount,
    date: date || today(),
    note: note ? String(note).slice(0, 200) : null,
    createdAt: new Date().toISOString(),
  };
}
