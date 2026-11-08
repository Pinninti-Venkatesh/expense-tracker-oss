import express from 'express';
import config from '../config.js';
import logger from '../utils/logger.js';
import * as razorpay from '../billing/razorpay.js';
import { updateBilling } from '../billing/records.js';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../billing/signatures.js';
import { applySubscription, billingSummary, LIVE_STATUSES, trialEnd } from '../billing/entitlement.js';

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// A subscription can start later (at the end of the trial, or of days already
// paid for) only if that's meaningfully in the future. Closer than this, it
// starts now.
const MIN_DEFERRED_START_MS = 60 * 60 * 1000;

// A subscription read straight from Razorpay's API is the newest view there is:
// at least as new as any event already applied, so it is never discarded as
// stale, and a webhook produced before this read that arrives after it is.
const readAt = (billing) => Math.max(Math.floor(Date.now() / 1000), Number(billing.statusAt) || 0);

// Webhook deliveries already applied, per account, to skip Razorpay's retries.
const REMEMBERED_EVENTS = 20;

const PLANS = ['monthly', 'yearly'];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const summary = (account) => billingSummary(account, { trialDays: config.trial.days });
const isoFromUnix = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

/** The plans on offer, with prices read from Razorpay. Empty when payments aren't set up. */
async function availablePlans() {
  if (!config.billing.enabled) return [];
  const out = [];
  for (const id of PLANS) {
    const planId = config.billing.plans[id];
    if (!planId) continue;
    try {
      // `id` is our name for the plan (monthly / yearly); Razorpay's own id stays behind.
      const { id: razorpayPlanId, ...plan } = await razorpay.getPlan(planId);
      out.push({ ...plan, id });
    } catch (err) {
      logger.error(`Could not load the ${id} plan from Razorpay`, err.message);
    }
  }
  return out;
}

router.get('/billing', asyncRoute(async (req, res) => {
  res.json({
    ...summary(req.account),
    configured: config.billing.enabled,
    plans: await availablePlans(),
  });
}));

/**
 * Starts a subscription for Razorpay Checkout to authorise. It begins when the
 * trial ends, or when days already paid for run out, so subscribing early never
 * costs a customer free days.
 *
 * A subscription created earlier but never paid for is reused for the same
 * plan, and cancelled when switching plans. One that can still charge is never
 * doubled up.
 */
router.post('/billing/subscribe', asyncRoute(async (req, res) => {
  if (!config.billing.enabled) return res.status(503).json({ error: 'Payments are not set up yet. Please try again later.' });

  const plan = req.body?.plan;
  const planId = PLANS.includes(plan) ? config.billing.plans[plan] : null;
  if (!planId) return res.status(400).json({ error: 'Choose a monthly or yearly plan.' });

  const saved = await updateBilling(req.account.id, async (billing, account) => {
    if (billing.subscriptionId && LIVE_STATUSES.has(billing.status)) {
      if (billing.status !== 'created') throw httpError(409, 'You already have a plan.');
      if (billing.plan === plan) return billing;
      await razorpay.cancelSubscription(billing.subscriptionId).catch((err) => {
        logger.warn(`Could not cancel an unpaid subscription for ${account.id}`, err.message);
      });
    }

    const now = Date.now();
    const freeUntil = Math.max(trialEnd(account, config.trial.days) ?? 0, Date.parse(billing.paidThrough || '') || 0);
    const startAt = freeUntil - now > MIN_DEFERRED_START_MS ? Math.floor(freeUntil / 1000) : null;

    const sub = await razorpay.createSubscription({
      planId,
      totalCount: config.billing.totalCount[plan],
      startAt,
      notes: { accountId: account.id, plan },
    });

    return {
      ...billing,
      subscriptionId: sub.id,
      previousSubscriptionIds: [...(billing.previousSubscriptionIds || []), billing.subscriptionId].filter(Boolean).slice(-10),
      plan,
      status: sub.status || 'created',
      // No Razorpay event has been applied to this subscription yet, so any
      // event or read that follows is newer, however the clocks disagree.
      statusAt: null,
      startAt: isoFromUnix(sub.start_at),
      currentEnd: null,
      endedAt: null,
    };
  });

  logger.info(`Billing: checkout opened for ${req.account.id} (${plan})`);
  res.json({
    subscriptionId: saved.billing.subscriptionId,
    keyId: config.billing.keyId,
    plan,
    startAt: saved.billing.startAt,
    name: config.product.name,
    prefill: { name: saved.name || '', email: saved.email || '' },
  });
}));

/**
 * The browser's word that Checkout succeeded. The signature proves Razorpay saw
 * a payment for the subscription this server created for this account; what
 * that payment bought is then read from Razorpay itself, not taken from the
 * browser. Webhooks deliver the same news independently.
 */
router.post('/billing/verify', asyncRoute(async (req, res) => {
  const {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: returnedId,
    razorpay_signature: signature,
  } = req.body || {};

  const saved = await updateBilling(req.account.id, async (billing) => {
    const subscriptionId = billing.subscriptionId;
    const genuine = subscriptionId && returnedId === subscriptionId
      && verifyCheckoutSignature({ paymentId, subscriptionId, signature }, config.billing.keySecret);
    if (!genuine) throw httpError(400, 'We could not confirm that payment. If money left your account, it will show up here within a few minutes.');

    const sub = await razorpay.fetchSubscription(subscriptionId);
    return applySubscription(billing, sub, {
      at: readAt(billing),
      charged: sub.status === 'active' && Number(sub.paid_count) > 0,
    });
  });

  logger.info(`Billing: checkout confirmed for ${req.account.id}`);
  res.json(summary(saved));
}));

/** Cancels renewal. Days already paid for are kept. */
router.post('/billing/cancel', asyncRoute(async (req, res) => {
  const saved = await updateBilling(req.account.id, async (billing) => {
    if (!billing.subscriptionId || !LIVE_STATUSES.has(billing.status)) throw httpError(409, 'There is no plan to cancel.');
    const sub = await razorpay.cancelSubscription(billing.subscriptionId);
    return applySubscription(billing, sub, { at: readAt(billing) });
  });

  logger.info(`Billing: cancelled for ${req.account.id}`);
  res.json(summary(saved));
}));

/**
 * Razorpay's subscription webhooks. Mounted ahead of the JSON body parser and
 * of sign-in (server/index.js): the signature is over the raw bytes, and
 * Razorpay has no session.
 *
 * Answers 2xx for anything genuine, including events it ignores, so Razorpay
 * doesn't retry them. Answers 5xx only when saving failed, so it does.
 */
export async function handleWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (!raw || !verifyWebhookSignature(raw, req.get('X-Razorpay-Signature'), config.billing.webhookSecret)) {
    logger.warn('Rejected a Razorpay webhook with a missing or wrong signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const name = String(event?.event || '');
  const sub = event?.payload?.subscription?.entity;
  const accountId = sub?.notes?.accountId;
  if (!name.startsWith('subscription.') || !sub?.id || !accountId) return res.json({ ok: true, ignored: true });

  const eventId = req.get('x-razorpay-event-id') || null;
  const payment = event.payload?.payment?.entity;
  const charged = (name === 'subscription.charged' || name === 'subscription.activated')
    && Boolean(payment) && payment.status !== 'failed';

  try {
    let outcome = 'applied';
    await updateBilling(accountId, (billing) => {
      if (eventId && (billing.recentEventIds || []).includes(eventId)) {
        outcome = 'duplicate';
        return billing;
      }
      const next = applySubscription(billing, sub, { at: Number(event.created_at) || null, charged });
      if (next === billing) {
        outcome = 'not this account’s subscription';
        return billing;
      }
      return { ...next, recentEventIds: [...(billing.recentEventIds || []), eventId].filter(Boolean).slice(-REMEMBERED_EVENTS) };
    });
    logger.info(`Billing webhook ${name} for ${accountId}: ${outcome}`);
    res.json({ ok: true });
  } catch (err) {
    logger.error(`Billing webhook ${name} for ${accountId} could not be saved`, err.message);
    res.status(500).json({ error: 'Could not save' });
  }
}

export default router;
