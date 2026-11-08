/**
 * Prices and plan wording for the plan screens. Amounts arrive from Razorpay in
 * the smallest unit (paise), as its plans store them.
 */

export function rupees(paise, currency = 'INR') {
  const amount = Number(paise) / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

const UNITS = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

/** "a month", "every 3 months". */
export function periodLabel(plan) {
  const unit = UNITS[plan?.period] || plan?.period || 'period';
  return plan?.interval > 1 ? `every ${plan.interval} ${unit}s` : `a ${unit}`;
}

export const priceLabel = (plan) => `${rupees(plan.amount, plan.currency)} ${periodLabel(plan)}`;

export const planName = (id) => (id === 'yearly' ? 'Yearly' : id === 'monthly' ? 'Monthly' : 'Your');

/** What a year of the monthly plan costs over the yearly one, in paise; 0 if nothing. */
export function yearlySaving(plans = []) {
  const monthly = plans.find((p) => p.period === 'monthly' && p.interval === 1);
  const yearly = plans.find((p) => p.period === 'yearly' && p.interval === 1);
  if (!monthly || !yearly || monthly.currency !== yearly.currency) return 0;
  return Math.max(0, monthly.amount * 12 - yearly.amount);
}

/** "18 Sep" for an ISO instant, in the viewer's own timezone. */
export function dayLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** The one line under "Plan" on the You screen. */
export function planLine(billing) {
  if (!billing) return '';
  const { reason, status, plan, renews, paidThrough, startAt, trialDaysLeft } = billing;
  if (reason === 'paid') return `${planName(plan)} plan · ${renews ? 'renews' : 'ends'} ${dayLabel(paidThrough)}`;
  if (status === 'authenticated') return `${planName(plan)} plan starts ${dayLabel(startAt)}`;
  if (reason === 'trial') return `Free trial · ${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left`;
  return 'Subscribe to keep using the app';
}

/** When billing will start if the customer subscribes now, or null for "now". */
export function billingStartsOn(billing) {
  if (!billing) return null;
  if (billing.reason === 'trial') return billing.trialEndsAt;
  if (billing.reason === 'paid' && !billing.renews) return billing.paidThrough;
  return null;
}
