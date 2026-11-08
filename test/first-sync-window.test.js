import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_TIMEZONE = 'Asia/Kolkata';
const { startOfPreviousMonth, startOfLocalDay, localDate } = await import('../server/utils/datetime.js');

const iso = (ms) => new Date(ms).toISOString();

test('the first sync starts at midnight India time on the 1st of last month, not midnight UTC', () => {
  // 15 Sep, mid-afternoon in India.
  const start = startOfPreviousMonth(Date.parse('2026-09-15T10:00:00Z'));
  assert.equal(iso(start), '2026-07-31T18:30:00.000Z'); // 1 Aug 00:00 IST
  assert.equal(localDate(start), '2026-08-01');
});

test('just after midnight on the 1st in India, "last month" is already the previous one', () => {
  // 1 Sep 01:30 IST is still 31 Aug in UTC.
  const start = startOfPreviousMonth(Date.parse('2026-08-31T20:00:00Z'));
  assert.equal(iso(start), '2026-07-31T18:30:00.000Z');
});

test('in January the window reaches back into December of the year before', () => {
  const start = startOfPreviousMonth(Date.parse('2027-01-10T06:00:00Z'));
  assert.equal(iso(start), '2026-11-30T18:30:00.000Z'); // 1 Dec 2026 00:00 IST
});

test('an alert at 00:10 India time on the 1st is inside the window', () => {
  const start = startOfPreviousMonth(Date.parse('2026-09-15T10:00:00Z'));
  const alertAt = Date.parse('2026-07-31T18:40:00Z'); // 1 Aug 00:10 IST
  assert.ok(alertAt >= start);
});

test('a local day start is correct for any day of the month', () => {
  assert.equal(iso(startOfLocalDay(2026, 3, 31)), '2026-03-30T18:30:00.000Z');
});
