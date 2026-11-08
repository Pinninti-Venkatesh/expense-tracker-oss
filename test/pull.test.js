import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gestureAxis, pullDistance, isPastThreshold, PULL_THRESHOLD, PULL_MAX } from '../web/src/lib/pull.js';

const at = (x, y) => ({ x, y });

test('a small wobble does not commit the gesture to a direction', () => {
  assert.equal(gestureAxis(at(100, 100), at(104, 105)), null);
});

test('mostly downward is a pull, mostly sideways is a swipe', () => {
  assert.equal(gestureAxis(at(100, 100), at(106, 140)), 'y');
  assert.equal(gestureAxis(at(100, 100), at(160, 110)), 'x');
});

test('the indicator follows at half speed and stops at its maximum', () => {
  assert.equal(pullDistance(at(0, 0), at(0, 60)), 30);
  assert.equal(pullDistance(at(0, 0), at(0, 1000)), PULL_MAX);
});

test('pushing up is never a pull', () => {
  assert.equal(pullDistance(at(0, 200), at(0, 120)), 0);
});

test('letting go refreshes only past the threshold', () => {
  assert.equal(isPastThreshold(PULL_THRESHOLD - 1), false);
  assert.equal(isPastThreshold(PULL_THRESHOLD), true);
  // A finger has to travel twice the threshold because of the resistance.
  assert.equal(isPastThreshold(pullDistance(at(0, 0), at(0, PULL_THRESHOLD * 2))), true);
});
