/**
 * The arithmetic of pull to refresh, kept free of React and the DOM so it can
 * be tested on its own.
 */

// How far the indicator has to travel before letting go refreshes.
export const PULL_THRESHOLD = 70;
// The indicator stops following the finger here.
export const PULL_MAX = 110;
// The indicator moves half as far as the finger, so the pull feels weighted.
const RESISTANCE = 0.5;
// Movement under this many pixels doesn't commit the gesture to a direction.
const SLOP = 8;

/**
 * Which way a touch that started at `start` is going: 'y' (a pull), 'x' (a
 * swipe across a segmented control or chip row), or null while it's too small
 * to tell. Decided once, so a pull that drifts sideways keeps pulling.
 */
export function gestureAxis(start, point) {
  const dx = Math.abs(point.x - start.x);
  const dy = Math.abs(point.y - start.y);
  if (dx < SLOP && dy < SLOP) return null;
  return dy > dx ? 'y' : 'x';
}

/** How far the indicator follows a finger that is now at `point`. */
export function pullDistance(start, point) {
  const dy = point.y - start.y;
  return dy <= 0 ? 0 : Math.min(dy * RESISTANCE, PULL_MAX);
}

export const isPastThreshold = (distance) => distance >= PULL_THRESHOLD;
