import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { cardLabel, money, shortDate } from '../lib/format.js';
import { Avatar } from '../components/ui.jsx';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// One first sync at a time, even if the screen remounts (StrictMode, a tab switch).
let running = null;

/**
 * The first minute: reads every bank alert since the 1st of last month, a batch
 * per request, counting up by card as rows land. Leaving is safe — processed
 * emails are skipped, so it carries on from here next time the app opens.
 */
export default function FirstSync({ expenses, onReload, onDone, onSkip }) {
  const [state, setState] = useState({ total: 0, remaining: null, since: null, error: null, busy: true });
  const mounted = useRef(true);
  const reloadRef = useRef(onReload);
  const doneRef = useRef(onDone);
  reloadRef.current = onReload;
  doneRef.current = onDone;

  const update = (patch) => {
    if (mounted.current) setState((s) => ({ ...s, ...patch }));
  };

  const start = useCallback(() => {
    if (running) return running;
    running = (async () => {
      try {
        for (;;) {
          const r = await api.firstSync();
          if (r.busy) {
            await sleep(3000);
            continue;
          }
          if (r.error) {
            update({ error: r.error, busy: false });
            return;
          }
          update({ total: r.scanned, remaining: r.remaining, since: r.since, busy: !r.done });
          await reloadRef.current();
          if (r.done) {
            await doneRef.current();
            return;
          }
        }
      } catch (err) {
        update({ error: err.message, busy: false });
      } finally {
        running = null;
      }
    })();
    return running;
  }, []);

  useEffect(() => {
    mounted.current = true;
    start();
    return () => { mounted.current = false; };
  }, [start]);

  const retry = () => {
    setState((s) => ({ ...s, error: null, busy: true }));
    start();
  };

  const found = useMemo(() => expenses.filter((e) => e.source === 'email'), [expenses]);
  const byCard = useMemo(() => {
    const map = new Map();
    for (const e of found) {
      const label = cardLabel(e) || 'Card';
      map.set(label, (map.get(label) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [found]);
  const latest = useMemo(
    () => [...found].sort((a, b) => ((b.createdAt || '') < (a.createdAt || '') ? -1 : 1)).slice(0, 2),
    [found],
  );

  const pct = state.total > 0 && state.remaining !== null ? (state.total - state.remaining) / state.total : 0;
  const circumference = 2 * Math.PI * 54;

  return (
    <div className="solo">
      <div className="solo-card">
        <div className={`ring${state.busy && !state.total ? ' spinning' : ''}`}>
          <svg viewBox="0 0 128 128" width="132" height="132" aria-hidden="true">
            <circle className="ring-track" cx="64" cy="64" r="54" />
            <circle
              className="ring-fill" cx="64" cy="64" r="54"
              strokeDasharray={`${state.total ? Math.max(0.04, pct) * circumference : circumference * 0.3} ${circumference}`}
              transform="rotate(-90 64 64)"
            />
          </svg>
          <div className="ring-mid"><b className="num">{found.length}</b><small>spends found</small></div>
        </div>

        <h1 className="center">
          {state.error ? 'Reading paused' : `Reading your bank alerts${state.since ? ` since ${shortDate(state.since)}` : ''}`}
        </h1>

        {byCard.length > 0 && (
          <div className="chipset center">
            {byCard.map(([label, count]) => (
              <span key={label} className="chip static">{label} <b className="num">{count}</b></span>
            ))}
          </div>
        )}

        {(latest.length > 0 || state.busy) && (
          <div className="card tx-list">
            {latest.map((e) => (
              <div key={e.id} className="tx static">
                <Avatar name={e.merchant} />
                <span className="tx-main"><span className="tx-title"><b>{e.merchant}</b></span><small>{e.category} · {shortDate(e.date)}</small></span>
                <span className="amt num">{money(e.amount)}</span>
              </div>
            ))}
            {state.busy && <div className="skel" aria-hidden="true"><i /><i /><i /></div>}
          </div>
        )}

        {state.error ? (
          <>
            <p className="error-text center">{state.error}</p>
            <button type="button" className="btn puffy wide" onClick={retry}>Try again</button>
            <button type="button" className="btn soft wide" onClick={onSkip}>Skip for now</button>
          </>
        ) : (
          <p className="muted small center">
            Usually a minute or two. If you leave, it carries on from here next time you open the app.
          </p>
        )}
      </div>
    </div>
  );
}
