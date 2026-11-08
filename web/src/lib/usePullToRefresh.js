import { useEffect, useRef, useState } from 'react';
import { gestureAxis, pullDistance, isPastThreshold, PULL_THRESHOLD } from './pull.js';

/**
 * Pull down from the top of any screen to check email and reload. Touch only;
 * on a laptop the "Updated 4 min ago" line is the button instead.
 *
 * The indicator holds at the threshold with a spinner until onRefresh settles,
 * and a new pull can't start meanwhile. The page's own overscroll is switched
 * off in styles.css, so Chrome on Android doesn't also reload the page.
 */
export function usePullToRefresh(onRefresh, enabled = true) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const gesture = useRef(null); // { start, axis, distance }
  const busy = useRef(false);
  const callback = useRef(onRefresh);
  callback.current = onRefresh;

  useEffect(() => {
    if (!enabled) return undefined;
    const pointOf = (e) => ({ x: e.touches[0].clientX, y: e.touches[0].clientY });

    const down = (e) => {
      const blocked = busy.current || e.touches.length !== 1 || window.scrollY > 0
        || document.body.classList.contains('sheet-open');
      gesture.current = blocked ? null : { start: pointOf(e), axis: null, distance: 0 };
    };

    const move = (e) => {
      const g = gesture.current;
      if (!g) return;
      const point = pointOf(e);
      g.axis ||= gestureAxis(g.start, point);
      if (g.axis === 'x') {
        // A swipe across a segmented control or a row of chips, not a pull.
        gesture.current = null;
        setPull(0);
        return;
      }
      if (g.axis !== 'y') return;
      g.distance = pullDistance(g.start, point);
      setPull(g.distance);
    };

    const up = async () => {
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      if (!isPastThreshold(g.distance)) {
        setPull(0);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      setPull(PULL_THRESHOLD);
      try {
        await callback.current();
      } finally {
        busy.current = false;
        setRefreshing(false);
        setPull(0);
      }
    };

    const cancel = () => {
      gesture.current = null;
      if (!busy.current) setPull(0);
    };

    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', cancel);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', cancel);
    };
  }, [enabled]);

  return { pull, ready: isPastThreshold(pull), refreshing };
}
