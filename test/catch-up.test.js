import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pollWindowStart, noteFailure } = await import('../server/poll.js');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-10-04T12:00:00Z');

test('a server that was never away reads the usual lookback', () => {
  assert.equal(pollWindowStart({ now, lastPollAt: null, lookbackHours: 24 }), now - DAY);
  assert.equal(pollWindowStart({ now, lastPollAt: 'garbage', lookbackHours: 24 }), now - DAY);
  // Polled an hour ago: the lookback already covers it.
  assert.equal(pollWindowStart({ now, lastPollAt: new Date(now - HOUR).toISOString(), lookbackHours: 24 }), now - DAY);
});

test('after days away it reads from just before the last clean poll, not just the last day', () => {
  const lastPollAt = new Date(now - 3 * DAY).toISOString();
  assert.equal(pollWindowStart({ now, lastPollAt, lookbackHours: 24 }), now - 3 * DAY - HOUR);
});

test('a very long absence is capped: further back is a first sync', () => {
  const lastPollAt = new Date(now - 400 * DAY).toISOString();
  assert.equal(pollWindowStart({ now, lastPollAt, lookbackHours: 24 }), now - 92 * DAY);
});

test('a failing email is retried, then given up on only after five tries over a day', () => {
  const d = { processedEmailIds: [], meta: {} };
  for (let i = 0; i < 6; i++) assert.equal(noteFailure(d, 'm1', now + i * HOUR), false, `try ${i + 1} within the day`);
  assert.equal(d.meta.pendingEmails.m1.attempts, 6);
  assert.deepEqual(d.processedEmailIds, []);

  assert.equal(noteFailure(d, 'm1', now + DAY + HOUR), true, 'a day later, it is given up on');
  assert.deepEqual(d.processedEmailIds, ['m1']);
  assert.equal(d.meta.pendingEmails.m1, undefined);
});

test('one bad email failing many times in a minute is not given up on', () => {
  const d = { processedEmailIds: [], meta: {} };
  for (let i = 0; i < 20; i++) assert.equal(noteFailure(d, 'm2', now + i * 1000), false);
});
