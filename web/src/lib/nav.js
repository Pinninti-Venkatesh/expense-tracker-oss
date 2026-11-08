import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Screens and sheets opened on top of a tab, mirrored into browser history.
 *
 * Every push adds a history entry, so Android's back gesture, the three-button
 * back key and the browser's back button all close the top item instead of
 * leaving the app. Closing from the UI goes through history too, so the two
 * never drift apart.
 */
export function useStack() {
  const [stack, setStack] = useState([]);
  const ref = useRef([]);

  useEffect(() => {
    window.history.replaceState({ depth: 0 }, '');
    const onPop = (event) => {
      const depth = Math.max(0, Math.min(Number(event.state?.depth) || 0, ref.current.length));
      ref.current = ref.current.slice(0, depth);
      setStack(ref.current);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const push = useCallback((item) => {
    ref.current = [...ref.current, { ...item, key: `${item.type}-${Date.now()}-${ref.current.length}` }];
    window.history.pushState({ depth: ref.current.length }, '');
    setStack(ref.current);
  }, []);

  /** Closes the top `count` items. */
  const pop = useCallback((count = 1) => {
    const n = Math.min(count, ref.current.length);
    if (n > 0) window.history.go(-n);
  }, []);

  /** Swaps the top item for another without growing history (sheet -> next sheet). */
  const replaceTop = useCallback((item) => {
    if (!ref.current.length) return push(item);
    ref.current = [...ref.current.slice(0, -1), { ...item, key: `${item.type}-${Date.now()}-r` }];
    window.history.replaceState({ depth: ref.current.length }, '');
    setStack(ref.current);
    return undefined;
  }, [push]);

  const reset = useCallback(() => pop(ref.current.length), [pop]);

  return { stack, push, pop, replaceTop, reset };
}
