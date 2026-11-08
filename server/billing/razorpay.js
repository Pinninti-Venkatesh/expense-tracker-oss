import config from '../config.js';

/**
 * The handful of Razorpay API calls the app makes, over plain HTTPS with basic
 * auth. Endpoints and fields follow Razorpay's API reference:
 *
 *   POST /v1/subscriptions               create (plan_id, total_count, start_at, notes)
 *   GET  /v1/subscriptions/:id           the subscription as Razorpay sees it now
 *   POST /v1/subscriptions/:id/cancel    cancel_at_cycle_end: false cancels now
 *   GET  /v1/plans/:id                   price and period, for the plan picker
 *
 * Plans are created once in the Razorpay dashboard and named by id in the
 * environment, so prices are changed there, never in code.
 */
const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15_000;
const PLAN_TTL_MS = 60 * 60 * 1000;

let fetchImpl = (...args) => fetch(...args);
const planCache = new Map(); // plan id -> { plan, at }

/** Tests swap the network for a fake. Never used by the app itself. */
export function __setFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
  planCache.clear();
}

async function call(method, path, body) {
  const { keyId, keySecret } = config.billing;
  if (!keyId || !keySecret) throw new Error('Razorpay keys are not configured');

  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // The description goes to the logs only. The browser gets a generic
    // message from the error handler, since this is a 5xx.
    const err = new Error(`Razorpay ${method} ${path.split('/')[1]} failed (${res.status}): ${data?.error?.description || 'no description'}`);
    err.status = 502;
    err.razorpayStatus = res.status;
    throw err;
  }
  return data;
}

export function createSubscription({ planId, totalCount, startAt = null, notes }) {
  return call('POST', '/subscriptions', {
    plan_id: planId,
    total_count: totalCount,
    // Razorpay emails the customer about authorisation and each charge.
    customer_notify: true,
    ...(startAt && { start_at: startAt }),
    notes,
  });
}

export const fetchSubscription = (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`);

/**
 * Cancels at once. Access comes from the days already paid for (see
 * entitlement.js), so cancelling now takes nothing away from the customer, and
 * it works in every state, unlike cancelling at the end of the cycle.
 */
export const cancelSubscription = (id) => call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: false });

/** { id, amount (paise), currency, period, interval, name } for a plan id, cached. */
export async function getPlan(planId) {
  const hit = planCache.get(planId);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;

  const data = await call('GET', `/plans/${encodeURIComponent(planId)}`);
  const plan = {
    id: data.id,
    amount: Number(data.item?.amount),
    currency: data.item?.currency || 'INR',
    period: data.period,
    interval: Number(data.interval) || 1,
    name: data.item?.name || null,
  };
  planCache.set(planId, { plan, at: Date.now() });
  return plan;
}
