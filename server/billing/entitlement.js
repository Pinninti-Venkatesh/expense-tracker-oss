/**
 * Who may use the app right now, worked out from the account record alone.
 *
 * Access comes from dates, not from Razorpay's status names:
 *
 *   trialEndsAt   createdAt + TRIAL_DAYS
 *   paidThrough   the end of the last billing cycle Razorpay charged for
 *                 (current_end on a charge). It only ever moves forward.
 *   startAt       when a mandate authorised during the trial first charges
 *
 * Status is kept for the screens ("renews on", "ends on"), but it never grants
 * access by itself: a cancelled subscription keeps the days it paid for, and a
 * renewal that fails ends access when those days run out, whatever state
 * Razorpay reports in between.
 *
 * SETTLE_MS is not a grace period. Razorpay charges at the end of a cycle, and
 * the webhook that proves it can arrive a while later. Without this margin a
 * customer whose renewal is going through would hit the paywall meanwhile.
 */
export const SETTLE_MS = 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// States in which a subscription can still charge the customer. Creating a
// second one alongside any of these could bill someone twice.
export const LIVE_STATUSES = new Set(['created', 'authenticated', 'active', 'pending']);

const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

const isoFromUnix = (seconds) => (Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null);

export function trialEnd(account, trialDays) {
  const created = ms(account?.createdAt);
  return created === null ? null : created + trialDays * DAY_MS;
}

/**
 * { entitled, reason } where reason is one of:
 *   paid         within a charged billing cycle
 *   trial        within the free trial
 *   starting     trial over, a mandate is authorised and its first charge is due
 *   trialEnded   the trial ran out and nothing was ever paid
 *   lapsed       paid before, and the paid days have run out
 */
export function accessFor(account, { trialDays, now = Date.now() }) {
  const billing = account?.billing || {};
  const paidThrough = ms(billing.paidThrough);
  const trialEndsAt = trialEnd(account, trialDays);
  const startAt = billing.status === 'authenticated' ? ms(billing.startAt) : null;

  if (paidThrough !== null && now < paidThrough + SETTLE_MS) return { entitled: true, reason: 'paid' };
  if (trialEndsAt !== null && now < trialEndsAt) return { entitled: true, reason: 'trial' };
  if (startAt !== null && now < startAt + SETTLE_MS) return { entitled: true, reason: 'starting' };
  return { entitled: false, reason: paidThrough !== null ? 'lapsed' : 'trialEnded' };
}

export const isEntitled = (account, opts) => accessFor(account, opts).entitled;

/** What the app is told about billing. Ids and dates only; no payment details. */
export function billingSummary(account, { trialDays, now = Date.now() }) {
  const billing = account?.billing || {};
  const { entitled, reason } = accessFor(account, { trialDays, now });
  const trialEndsAt = trialEnd(account, trialDays);
  const status = billing.status || null;

  return {
    entitled,
    reason,
    trialEndsAt: trialEndsAt === null ? null : new Date(trialEndsAt).toISOString(),
    trialDaysLeft: trialEndsAt === null ? null : Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS)),
    plan: billing.plan || null,
    status,
    paidThrough: billing.paidThrough || null,
    startAt: billing.startAt || null,
    // Cancelling is always immediate (billing/razorpay.js), so a live
    // subscription is one that will charge again.
    renews: status === 'active' || status === 'authenticated',
    // Checkout can be reopened for a subscription that was created but never paid.
    awaitingPayment: status === 'created',
  };
}

/**
 * Folds a Razorpay subscription entity into the account's billing record and
 * returns the new record. Pure: the caller saves it.
 *
 *   at       when Razorpay produced this view of the subscription (unix seconds).
 *            A view older than the one already applied never overwrites the
 *            status, because webhooks can arrive out of order.
 *   charged  this view comes from a successful charge, so its current_end is
 *            now paid for.
 *
 * A subscription this account didn't create is ignored rather than trusted.
 */
export function applySubscription(billing = {}, sub, { at = null, charged = false } = {}) {
  if (!sub?.id || !billing.subscriptionId || sub.id !== billing.subscriptionId) return billing;

  const next = { ...billing };
  const stale = at !== null && billing.statusAt !== undefined && billing.statusAt !== null && at < billing.statusAt;
  if (!stale) {
    next.status = sub.status || next.status;
    next.statusAt = at ?? next.statusAt ?? null;
    next.startAt = isoFromUnix(sub.start_at) || next.startAt || null;
    next.currentEnd = isoFromUnix(sub.current_end) || next.currentEnd || null;
    if (sub.status === 'cancelled' || sub.status === 'completed' || sub.status === 'expired' || sub.status === 'halted') {
      next.endedAt = isoFromUnix(sub.ended_at) || next.endedAt || null;
    }
  }

  if (charged) {
    const end = isoFromUnix(sub.current_end);
    if (end && (!next.paidThrough || Date.parse(end) > Date.parse(next.paidThrough))) next.paidThrough = end;
  }
  return next;
}
