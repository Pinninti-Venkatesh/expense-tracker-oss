import { useMemo, useState } from 'react';
import { aggregate, filterExpenses, monthComparison, monthRecap } from '../lib/analytics.js';
import { money, monthName, sinceLabel } from '../lib/format.js';
import { newestFirst } from '../lib/group.js';
import { peopleTotals, personSummary } from '../lib/people.js';
import PaceChart from '../components/PaceChart.jsx';
import Bars from '../components/Bars.jsx';
import SpendRow from '../components/SpendRow.jsx';
import { Avatar, Chip, Icon } from '../components/ui.jsx';

const PIN_PROMPT_KEY = 'et.pinPromptDismissed';

const readFlag = (key) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

const writeFlag = (key) => {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Storage blocked: the prompt returns next visit, which is harmless.
  }
};

/** "Updated 4 min ago" — and the button that checks email now. */
export function LiveLine({ me, syncing, onSync, className = '' }) {
  const busy = syncing || me?.syncing;
  const text = busy
    ? 'Checking your email…'
    : me?.lastSyncAt ? `Updated ${sinceLabel(me.lastSyncAt)}` : `Checks email every ${me?.pollMinutes || 10} min`;
  return (
    <button type="button" className={`live ${className}`} onClick={onSync} disabled={busy} title="Check email now">
      <span className={`dot${busy ? ' busy' : ''}`} />
      {text}
    </button>
  );
}

function PaceTag({ comparison }) {
  if (!comparison.hasPrevious) return <span className="tag grey">First month tracked</span>;

  const now = new Date();
  const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const sameDay = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), lastDayPrev))
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const delta = comparison.soFar - comparison.previousAtSameDay;

  if (Math.abs(delta) < 1) return <span className="tag grey">Same as by {sameDay}</span>;
  return delta < 0
    ? <span className="tag good">{money(-delta)} less than by {sameDay}</span>
    : <span className="tag warn">{money(delta)} more than by {sameDay}</span>;
}

function ReviewCard({ items, onAnswer, onLooksRight, onOpenSpend, busyId }) {
  const e = items[0];
  const options = e.categoryOptions?.length ? e.categoryOptions : [e.category];

  return (
    <section className="card review-card">
      <div className="card-head">
        <h2>Needs a look</h2>
        <span className="muted small">{items.length === 1 ? '1 spend' : `1 of ${items.length}`}</span>
      </div>
      <button type="button" className="tx flat" onClick={() => onOpenSpend(e)}>
        <Avatar name={e.merchant} />
        <span className="tx-main">
          <span className="tx-title"><b>{e.merchant} · {money(e.amount)}</b></span>
          <small>{options.length > 1 ? `${options.join(' or ')}?` : `Is ${e.category} right?`}</small>
        </span>
        <Icon name="chev" size={16} />
      </button>
      <div className="chipset">
        {options.map((c) => (
          <Chip
            key={c} disabled={busyId === e.id}
            onClick={() => (c === e.category ? onLooksRight(e) : onAnswer(e, c))}
          >
            {options.length === 1 ? `Yes, ${c}` : c}
          </Chip>
        ))}
        <Chip onClick={() => onOpenSpend(e)}>Other…</Chip>
      </div>
    </section>
  );
}

function RecapCard({ recap }) {
  const max = Math.max(1, ...recap.byCategory.map((c) => c.total));
  const shift = recap.biggestShift;

  return (
    <section className="glass recap">
      <span className="glass-label">Your {recap.label}</span>
      <div className="glass-big num">{money(recap.total)}</div>
      {recap.change !== null && (
        <span className="glass-sub">
          {money(Math.abs(recap.change))} {recap.change > 0 ? 'more' : 'less'} than {recap.previousLabel}
        </span>
      )}
      <div className="gbars">
        {recap.byCategory.map((c) => (
          <div className="gbar" key={c.category}>
            <em>{c.category}</em>
            <span className="gtrack"><i style={{ width: `${Math.max(3, (c.total / max) * 100)}%` }} /></span>
            <span className="num">{money(c.total)}</span>
          </div>
        ))}
      </div>
      <div className="recap-facts">
        {shift && (
          <span>Biggest change <b>{shift.category} {shift.delta > 0 ? 'up' : 'down'} {money(Math.abs(shift.delta))}</b></span>
        )}
        {recap.topPlace && <span>Top place <b>{recap.topPlace.merchant} {money(recap.topPlace.total)}</b></span>}
      </div>
    </section>
  );
}

export default function Home({
  expenses, me, people, pinEnabled, masked, onToggleMask, onOpenYou, onOpenSpend, onSeeAll,
  onSync, syncing, onAnswer, onLooksRight, answeringId, onSetPin, onOpenPerson, onOpenPeople,
  settle, onSettleAll, settlingAll,
}) {
  const now = new Date();
  const comparison = useMemo(() => monthComparison(expenses), [expenses]);
  const month = useMemo(() => filterExpenses(expenses, { period: 'month' }), [expenses]);
  const stats = useMemo(() => aggregate(month), [month]);
  const recap = useMemo(() => monthRecap(expenses), [expenses]);
  const review = useMemo(() => expenses.filter((e) => e.needsReview && !e.transfer && e.isExpense !== false), [expenses]);
  const latest = useMemo(() => filterExpenses(expenses, { period: 'all' }).sort(newestFirst).slice(0, 5), [expenses]);
  const totals = peopleTotals(people);
  const owing = people.filter((p) => p.net >= 0.01).slice(0, 3);
  const [pinDismissed, setPinDismissed] = useState(() => readFlag(PIN_PROMPT_KEY));

  const reviewCard = review.length > 0 && (
    <ReviewCard items={review} onAnswer={onAnswer} onLooksRight={onLooksRight} onOpenSpend={onOpenSpend} busyId={answeringId} />
  );

  return (
    <div className="page home">

      <header className="screen-head">
        <button type="button" className="me-btn" onClick={onOpenYou} aria-label="You and settings">
          <Avatar name={me?.name || me?.email || 'You'} round />
        </button>
        <div className="screen-title"><h1>{monthName(now)}</h1></div>
        <button
          type="button" className={`icon-btn${masked ? ' on' : ''}`} onClick={() => onToggleMask(!masked)}
          aria-pressed={masked} aria-label={masked ? 'Show amounts' : 'Hide amounts'}
        >
          <Icon name={masked ? 'eyeOff' : 'eye'} />
        </button>
      </header>

      <section className="hero">
        <LiveLine me={me} syncing={syncing} onSync={onSync} className="phone-only" />
        <span className="hero-label">Spent so far</span>
        <div className="big num">{money(comparison.soFar)}</div>
        <div className="chipset">
          <PaceTag comparison={comparison} />
          <span className="tag grey">{stats.count} spend{stats.count === 1 ? '' : 's'}</span>
          {stats.outstanding > 0 && <span className="tag">{money(stats.outstanding)} owed to you</span>}
        </div>
      </section>

      <div className="home-grid">
        <div className="home-main">
          {recap && <RecapCard recap={recap} />}

          <section className="card">
            <div className="card-head">
              <h2>Pace this month</h2>
              {comparison.hasPrevious && <span className="muted small">dashed: {comparison.previousLabel}</span>}
            </div>
            <PaceChart comparison={comparison} />
          </section>

          {reviewCard && <div className="phone-only">{reviewCard}</div>}

          {settle.enabled && settle.count > 0 && (
            <section className="card">
              <div className="card-head"><h2>To settle</h2><span className="muted small">{settle.count} card spend{settle.count === 1 ? '' : 's'}</span></div>
              <div className="row">
                <span className="mid num">{money(settle.total)}</span>
                <button type="button" className="btn soft sm" onClick={onSettleAll} disabled={settlingAll}>
                  {settlingAll ? 'Settling…' : 'Settle all'}
                </button>
              </div>
              <span className="muted small">Card spends still to move into your bank account.</span>
            </section>
          )}

          {!pinEnabled && !pinDismissed && month.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>Keep it yours</h2></div>
              <p className="muted small">Your spending is on screen now. A PIN keeps it private if someone picks up your unlocked phone.</p>
              <div className="action-row">
                <button type="button" className="btn puffy sm" onClick={onSetPin}><Icon name="lock" size={16} />Set a PIN</button>
                <button type="button" className="btn soft sm" onClick={() => { writeFlag(PIN_PROMPT_KEY); setPinDismissed(true); }}>Not now</button>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Latest</h2>
              <button type="button" className="link" onClick={onSeeAll}>See all</button>
            </div>
            {latest.length ? (
              <div className="tx-list">
                {latest.map((e) => <SpendRow key={e.id} expense={e} onOpen={onOpenSpend} settleEnabled={settle.enabled} />)}
              </div>
            ) : (
              <p className="muted small">No spends yet. New card alerts show up here within about 10 minutes.</p>
            )}
          </section>
        </div>

        <aside className="home-side wide-only">
          {reviewCard}

          {stats.byCategory.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>By category</h2>
                <button type="button" className="link" onClick={onSeeAll}>Charts</button>
              </div>
              <Bars rows={stats.byCategory.slice(0, 5).map((c) => ({ id: c.category, label: c.category, value: c.total }))} />
            </section>
          )}

          {owing.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>Friends owe you</h2>
                <button type="button" className="link num" onClick={onOpenPeople}>{money(totals.owedToYou)}</button>
              </div>
              <div className="tx-list">
                {owing.map((p) => (
                  <button type="button" key={p.key} className="tx" onClick={() => onOpenPerson(p.key)}>
                    <Avatar name={p.name} round />
                    <span className="tx-main"><span className="tx-title"><b>{p.name}</b></span><small>{personSummary(p)}</small></span>
                    <span className="amt num">{money(p.net)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
