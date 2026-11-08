import { useCallback, useEffect, useRef, useState } from 'react';
import { api, AuthRequiredError, PinRequiredError, PaymentRequiredError } from './api.js';

/**
 * How often a screen you are actually looking at re-checks the server.
 *
 * The only background writer is the scheduled poll, every ten minutes, so asking
 * once a minute while the app is in front is plenty. Nothing is asked while it is
 * hidden: never hold a connection open (see the old SSE note in git history —
 * it was 94% of the Cloud Run bill).
 */
const REFRESH_MS = 60_000;

// Not financial data: a date and a file link, kept so the "Paused" screen can
// say how far the ledger reaches and where it lives when Google access has
// stopped and the server can no longer be asked.
const LAST_SEEN_KEY = 'et.lastSeen';

export function readLastSeen() {
  try {
    return JSON.parse(localStorage.getItem(LAST_SEEN_KEY) || 'null');
  } catch {
    return null;
  }
}

function rememberLastSeen(expenses, me) {
  try {
    const latest = expenses.reduce((max, e) => (e.date > max ? e.date : max), '');
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ latest: latest || null, driveFileUrl: me?.driveFileUrl || null }));
  } catch {
    // Private mode or blocked storage: the Paused screen just says less.
  }
}

/**
 * Everything the app shows, loaded together and refreshed together.
 *
 * status: loading | signedOut | ready | locked | paused | paywall | error
 */
export function useAppData() {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [ledger, setLedger] = useState(null);
  const [loans, setLoans] = useState(null);
  const [me, setMe] = useState(null);
  const [pinStatus, setPinStatus] = useState(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const fail = useCallback((err) => {
    if (err instanceof PinRequiredError) setStatus('locked');
    else if (err instanceof PaymentRequiredError) setStatus('paywall');
    else if (err instanceof AuthRequiredError) setStatus(err.reason === 'reconnect' ? 'paused' : 'loading');
    else {
      setError(err.message);
      setStatus('error');
    }
  }, []);

  const loadPinStatus = useCallback(() => api.pinStatus().then(setPinStatus).catch(() => {}), []);

  const loadExpenses = useCallback(async () => {
    const r = await api.listExpenses();
    setExpenses(r.expenses);
    setCategories(r.categories);
    return r.expenses;
  }, []);

  const loadMe = useCallback(async () => {
    const r = await api.me();
    setMe(r);
    return r;
  }, []);

  const loadLedger = useCallback(() => api.ledger().then(setLedger), []);
  const loadLoans = useCallback(() => api.loans().then(setLoans), []);

  const loadAll = useCallback(async () => {
    try {
      // Asked together, but /me is waited for first: it's reachable past the
      // paywall, so the subscribe screen always has the account to show.
      const account = loadMe();
      const rest = Promise.all([loadExpenses(), loadLedger(), loadLoans()]);
      rest.catch(() => {}); // observed below; this only stops an early "unhandled" warning
      const me = await account;
      const [list] = await rest;
      rememberLastSeen(list, me);
      setError(null);
      setStatus('ready');
    } catch (err) {
      fail(err);
    }
  }, [fail, loadExpenses, loadMe, loadLedger, loadLoans]);

  // Signed out, the app shows its welcome screens rather than bouncing to Google.
  useEffect(() => {
    let cancelled = false;
    api.session()
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        if (!s.signedIn) {
          setStatus('signedOut');
          return;
        }
        loadPinStatus();
        loadAll();
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, [loadAll, loadPinStatus]);

  // Refresh while in front; catch up the moment the app comes back.
  useEffect(() => {
    if (status !== 'ready') return undefined;
    let timer = null;
    const tick = () => Promise.all([loadExpenses(), loadMe()]).catch(fail);
    const start = () => { timer ||= setInterval(tick, REFRESH_MS); };
    const stop = () => { clearInterval(timer); timer = null; };
    const onVisibility = () => {
      if (document.hidden) return stop();
      tick();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [status, fail, loadExpenses, loadMe]);

  /** Wraps a mutation: runs it, then reloads what it touched. Errors propagate. */
  const refresh = useCallback(async (...what) => {
    const all = !what.length;
    const jobs = [];
    if (all || what.includes('expenses')) jobs.push(loadExpenses());
    if (all || what.includes('ledger')) jobs.push(loadLedger());
    if (all || what.includes('loans')) jobs.push(loadLoans());
    if (all || what.includes('me')) jobs.push(loadMe());
    try {
      await Promise.all(jobs);
    } catch (err) {
      fail(err);
    }
  }, [fail, loadExpenses, loadLedger, loadLoans, loadMe]);

  const lock = useCallback(() => setStatus('locked'), []);

  return {
    status, error, session, expenses, categories, ledger, loans, me, pinStatus,
    loadAll, refresh, lock, loadPinStatus, setExpenses, handleError: fail,
  };
}
