import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rupees, periodLabel, priceLabel, yearlySaving, planLine, billingStartsOn,
} from '../web/src/lib/billing.js';

const monthly = { id: 'monthly', amount: 9900, currency: 'INR', period: 'monthly', interval: 1 };
const yearly = { id: 'yearly', amount: 99900, currency: 'INR', period: 'yearly', interval: 1 };

test('prices come from paise and drop the decimals when whole', () => {
  assert.equal(rupees(9900), '₹99');
  assert.equal(rupees(99950), '₹999.50');
  assert.equal(rupees(1234500), '₹12,345');
});

test('plan periods read naturally', () => {
  assert.equal(periodLabel(monthly), 'a month');
  assert.equal(periodLabel({ period: 'monthly', interval: 3 }), 'every 3 months');
  assert.equal(priceLabel(yearly), '₹999 a year');
});

test('the yearly saving is what twelve months would cost over the yearly price', () => {
  assert.equal(yearlySaving([monthly, yearly]), 18900);
  assert.equal(yearlySaving([monthly]), 0);
  assert.equal(yearlySaving([monthly, { ...yearly, amount: 200000 }]), 0);
});

test('the plan line on the You screen covers every state', () => {
  const base = { trialDaysLeft: 3, plan: 'monthly', paidThrough: '2026-10-15T00:00:00.000Z', startAt: '2026-09-29T00:00:00.000Z' };
  assert.equal(planLine({ ...base, reason: 'trial', status: null }), 'Free trial · 3 days left');
  assert.equal(planLine({ ...base, reason: 'trial', trialDaysLeft: 1 }), 'Free trial · 1 day left');
  assert.match(planLine({ ...base, reason: 'trial', status: 'authenticated' }), /^Monthly plan starts \d+ Sept?$/);
  assert.match(planLine({ ...base, reason: 'paid', renews: true }), /^Monthly plan · renews 1[45] Oct$/);
  assert.match(planLine({ ...base, reason: 'paid', renews: false }), /^Monthly plan · ends/);
  assert.equal(planLine({ ...base, reason: 'lapsed' }), 'Subscribe to keep using the app');
});

test('subscribing early starts billing when the free or paid days end', () => {
  assert.equal(billingStartsOn({ reason: 'trial', trialEndsAt: 'T' }), 'T');
  assert.equal(billingStartsOn({ reason: 'paid', renews: false, paidThrough: 'P' }), 'P');
  assert.equal(billingStartsOn({ reason: 'lapsed' }), null);
});
