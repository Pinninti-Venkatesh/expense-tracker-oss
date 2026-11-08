import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFor, billingSummary, applySubscription, SETTLE_MS } from '../server/billing/entitlement.js';

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const trialDays = 14;
const unix = (ms) => Math.floor(ms / 1000);
const account = (billing) => ({ id: 'acc', createdAt: new Date(T0).toISOString(), ...(billing && { billing }) });

test('a new account is in its trial until the last trial day ends', () => {
  assert.deepEqual(accessFor(account(), { trialDays, now: T0 + 13 * DAY }), { entitled: true, reason: 'trial' });
  assert.deepEqual(accessFor(account(), { trialDays, now: T0 + 14 * DAY }), { entitled: false, reason: 'trialEnded' });
});

test('trial days left counts part days as a day and never goes negative', () => {
  assert.equal(billingSummary(account(), { trialDays, now: T0 + 1 }).trialDaysLeft, 14);
  assert.equal(billingSummary(account(), { trialDays, now: T0 + 13.5 * DAY }).trialDaysLeft, 1);
  assert.equal(billingSummary(account(), { trialDays, now: T0 + 40 * DAY }).trialDaysLeft, 0);
});

test('paid days carry access past the trial, with a margin for the renewal to land', () => {
  const paidThrough = new Date(T0 + 44 * DAY).toISOString();
  const acc = account({ subscriptionId: 'sub_1', status: 'active', paidThrough });
  assert.equal(accessFor(acc, { trialDays, now: T0 + 30 * DAY }).reason, 'paid');
  assert.equal(accessFor(acc, { trialDays, now: T0 + 44 * DAY + SETTLE_MS - 1 }).entitled, true);
  assert.deepEqual(accessFor(acc, { trialDays, now: T0 + 44 * DAY + SETTLE_MS }), { entitled: false, reason: 'lapsed' });
});

test('cancelling keeps the days already paid for', () => {
  const acc = account({ subscriptionId: 'sub_1', status: 'cancelled', paidThrough: new Date(T0 + 44 * DAY).toISOString() });
  assert.equal(accessFor(acc, { trialDays, now: T0 + 40 * DAY }).entitled, true);
});

test('a failed renewal ends access when the paid days run out, whatever the status says', () => {
  for (const status of ['pending', 'halted', 'active']) {
    const acc = account({ subscriptionId: 'sub_1', status, paidThrough: new Date(T0 + 44 * DAY).toISOString() });
    assert.equal(accessFor(acc, { trialDays, now: T0 + 50 * DAY }).entitled, false, status);
  }
});

test('a mandate authorised in the trial keeps access until its first charge is due', () => {
  const startAt = new Date(T0 + 14 * DAY).toISOString();
  const acc = account({ subscriptionId: 'sub_1', status: 'authenticated', startAt });
  assert.equal(accessFor(acc, { trialDays, now: T0 + 14 * DAY + 60_000 }).reason, 'starting');
  assert.equal(accessFor(acc, { trialDays, now: T0 + 14 * DAY + SETTLE_MS }).entitled, false);

  // A subscription that was only created, never authorised, grants nothing.
  const created = account({ subscriptionId: 'sub_1', status: 'created', startAt });
  assert.equal(accessFor(created, { trialDays, now: T0 + 14 * DAY + 60_000 }).entitled, false);
});

test('an account without a creation date has no trial, so it fails closed', () => {
  assert.deepEqual(accessFor({ id: 'legacy' }, { trialDays, now: T0 }), { entitled: false, reason: 'trialEnded' });
});

test('a charge moves paid-through forward to the end of the charged cycle', () => {
  const billing = { subscriptionId: 'sub_1', status: 'authenticated', statusAt: unix(T0) };
  const next = applySubscription(billing, {
    id: 'sub_1', status: 'active', start_at: unix(T0 + 14 * DAY), current_end: unix(T0 + 44 * DAY),
  }, { at: unix(T0 + 14 * DAY), charged: true });

  assert.equal(next.status, 'active');
  assert.equal(next.paidThrough, new Date(T0 + 44 * DAY).toISOString());
  assert.equal(next.startAt, new Date(T0 + 14 * DAY).toISOString());
});

test('an older event arriving late does not overwrite a newer status or pull paid-through back', () => {
  const billing = {
    subscriptionId: 'sub_1', status: 'cancelled', statusAt: unix(T0 + 20 * DAY),
    paidThrough: new Date(T0 + 44 * DAY).toISOString(),
  };
  const next = applySubscription(billing, { id: 'sub_1', status: 'active', current_end: unix(T0 + 30 * DAY) }, { at: unix(T0 + 15 * DAY), charged: true });
  assert.equal(next.status, 'cancelled');
  assert.equal(next.paidThrough, new Date(T0 + 44 * DAY).toISOString());
});

test('an event that is not a charge never extends paid-through', () => {
  const billing = { subscriptionId: 'sub_1', status: 'active', statusAt: unix(T0), paidThrough: new Date(T0 + 30 * DAY).toISOString() };
  const next = applySubscription(billing, { id: 'sub_1', status: 'pending', current_end: unix(T0 + 60 * DAY) }, { at: unix(T0 + 31 * DAY) });
  assert.equal(next.status, 'pending');
  assert.equal(next.paidThrough, new Date(T0 + 30 * DAY).toISOString());
});

test("another subscription's event is ignored, as is one for an account that never subscribed", () => {
  const billing = { subscriptionId: 'sub_mine', status: 'created' };
  assert.equal(applySubscription(billing, { id: 'sub_other', status: 'active', current_end: unix(T0 + 99 * DAY) }, { charged: true }), billing);
  const none = {};
  assert.equal(applySubscription(none, { id: 'sub_any', status: 'active' }, { charged: true }), none);
});

test('the summary says when checkout can be reopened and whether the plan renews', () => {
  const created = billingSummary(account({ subscriptionId: 's', status: 'created', plan: 'monthly' }), { trialDays, now: T0 });
  assert.equal(created.awaitingPayment, true);
  assert.equal(created.renews, false);

  const active = billingSummary(account({ subscriptionId: 's', status: 'active', plan: 'yearly' }), { trialDays, now: T0 });
  assert.equal(active.renews, true);
  const cancelled = billingSummary(account({ subscriptionId: 's', status: 'cancelled', plan: 'yearly' }), { trialDays, now: T0 });
  assert.equal(cancelled.renews, false);
});
