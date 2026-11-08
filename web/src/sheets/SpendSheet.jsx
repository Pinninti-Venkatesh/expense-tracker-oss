import { useMemo, useState } from 'react';
import {
  effectiveAmount, isFullyRefunded, isSettleable, refundedTotal, settleAmount, siblingsOf,
} from '../lib/analytics.js';
import { cardLabel, formatDay, formatTime, money, shortDate } from '../lib/format.js';
import CategoryChips from '../components/CategoryChips.jsx';
import { Avatar, ConfirmButton, Empty, Icon, Sheet, Toggle } from '../components/ui.jsx';

const STATUS = { pending: 'owes you', settled: 'paid you back', waived: 'let go' };
const MODE = { equal: 'Split equally', shares: 'Split by shares', exact: 'Split by amount', lent: 'Paid for them' };

function SplitPanel({ expense, busy, run, actions }) {
  const s = expense.split;
  return (
    <div className="inset">
      <div className="row">
        <span className="lbl">{MODE[s.mode] || 'Split'}</span>
        <span className="muted small">Your share {money(s.yourShare)}</span>
      </div>
      {s.participants.map((p) => (
        <div key={p.id} className="split-line">
          <span><b>{p.name}</b> <small className="muted">{STATUS[p.status]}</small></span>
          <span className="split-actions">
            <b className="num">{money(p.owed)}</b>
            {p.status === 'pending' ? (
              <>
                <button type="button" className="link" disabled={busy === p.id} onClick={() => run(p.id, () => actions.setSplitStatus(expense, p.id, 'settled'))}>
                  Got it back
                </button>
                <button type="button" className="link subtle" disabled={busy === p.id} onClick={() => run(p.id, () => actions.setSplitStatus(expense, p.id, 'waived'))}>
                  Let it go
                </button>
              </>
            ) : (
              <button type="button" className="link" disabled={busy === p.id} onClick={() => run(p.id, () => actions.setSplitStatus(expense, p.id, 'pending'))}>
                Undo
              </button>
            )}
          </span>
        </div>
      ))}
      <ConfirmButton className="link danger" label="Remove split" confirmLabel="Tap again to remove the split" onConfirm={() => actions.unsplit(expense)} />
    </div>
  );
}

/** One spend: what it was, one-tap category, split and refund, and the rest under the bottom row. */
export default function SpendSheet({ expense: e, allExpenses, categories, settings, onClose, actions, notify }) {
  const [alsoPast, setAlsoPast] = useState(true);
  const [busy, setBusy] = useState(null);
  const siblings = useMemo(() => (e ? siblingsOf(allExpenses, e).count : 0), [allExpenses, e]);

  if (!e) {
    return (
      <Sheet title="Spend" onClose={onClose}>
        <Empty title="This spend is gone">It was deleted or moved.</Empty>
      </Sheet>
    );
  }

  const yours = effectiveAmount(e);
  const settleable = settings?.settleEnabled && isSettleable(e);
  const toSettle = settleAmount(e);
  const hasDetails = Boolean(e.description || e.items?.length);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const pick = (category) => {
    if (category === e.category) {
      if (e.needsReview) run('category', () => actions.markReviewed(e));
      return;
    }
    run('category', () => actions.setCategory(e, category, alsoPast && siblings > 0));
  };

  const when = [formatDay(e.date), formatTime(e.at)].filter(Boolean).join(', ');

  return (
    <Sheet title={null} onClose={onClose} className="spend-sheet">
      <div className="spend-head">
        <Avatar name={e.merchant} size={44} />
        <div className="spend-id">
          <b>{e.merchant}{e.corrected && <span className="badge grey">fixed</span>}</b>
          <small>{[when, cardLabel(e)].filter(Boolean).join(' · ')}</small>
        </div>
        <div className="spend-amt num">
          <b>{money(yours)}</b>
          {Math.abs(yours - Number(e.amount)) > 0.004 && <s>{money(e.amount)}</s>}
        </div>
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>

      {e.needsReview && <p className="notice amber">Not sure this is {e.category}. Pick the right category below.</p>}
      {e.transfer && <p className="notice">Not counted as spending: money between your own accounts.</p>}
      {e.isExpense === false && <p className="notice">Marked as not a real spend, so it isn&apos;t counted.</p>}

      {hasDetails ? (
        <div className="inset">
          <span className="lbl">{e.detailsSource === 'manual' ? 'Your details' : 'From the order email'}</span>
          {e.description && <p>{e.description}</p>}
          {e.items?.length > 0 && <p className="muted">{e.items.join(' · ')}</p>}
        </div>
      ) : e.source === 'email' ? (
        <div className="inset row">
          <span className="muted small">
            {e.enrichStatus === 'no_order_email'
              ? 'No order email from this place.'
              : e.enrichStatus === 'not_an_order'
                ? "Their email didn't list what you bought."
                : 'See what you bought, from the order email.'}
          </span>
          {!e.enrichStatus && (
            <button type="button" className="btn soft sm" disabled={busy === 'lookup'} onClick={() => run('lookup', () => actions.lookup(e))}>
              {busy === 'lookup' ? 'Looking…' : 'Find it'}
            </button>
          )}
        </div>
      ) : null}

      {e.note && <p className="muted small">Note: {e.note}</p>}

      <div className="stack-sm">
        <span className="lbl">Category</span>
        <CategoryChips
          key={e.id} value={e.category} categories={categories} suggestions={e.categoryOptions || []}
          onPick={pick} onAddCategory={actions.addCategory} disabled={busy === 'category'} idPrefix={`cat-${e.id}`}
        />
        {siblings > 0 && (
          <div className="toggle-row">
            <label htmlFor={`past-${e.id}`}>Also fix {siblings} past {e.merchant} spend{siblings === 1 ? '' : 's'}</label>
            <Toggle id={`past-${e.id}`} checked={alsoPast} onChange={setAlsoPast} label="Also fix past spends" />
          </div>
        )}
        <span className="muted small">A change is remembered for {e.merchant} from now on.</span>
      </div>

      {e.split && <SplitPanel expense={e} busy={busy} run={run} actions={actions} />}

      {e.refunds?.length > 0 && (
        <div className="inset">
          <span className="lbl">Refunds · {money(refundedTotal(e))}</span>
          {e.refunds.map((r) => (
            <div key={r.id} className="split-line">
              <span>{shortDate(r.date)}{r.note ? ` · ${r.note}` : ''}</span>
              <span className="split-actions">
                <b className="num">{money(r.amount)}</b>
                <button type="button" className="link danger" disabled={busy === r.id} onClick={() => run(r.id, () => actions.removeRefund(e, r.id))}>Undo</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {settleable && (e.settled || toSettle > 0.005) && (
        <div className="toggle-row">
          <span>{e.settled ? 'Settled: moved to your bank' : `Move ${money(toSettle)} to your bank`}</span>
          <button type="button" className="btn soft sm" disabled={busy === 'settle'} onClick={() => run('settle', () => actions.settle(e, !e.settled))}>
            {e.settled ? 'Undo' : 'Mark settled'}
          </button>
        </div>
      )}

      <div className="action-row">
        <button type="button" className="btn soft" onClick={() => actions.openSplit(e)}>
          <Icon name="people" size={17} />{e.split ? 'Edit split' : 'Split with friends'}
        </button>
        {!isFullyRefunded(e) && (
          <button type="button" className="btn soft" onClick={() => actions.openRefund(e)}>Record refund</button>
        )}
      </div>

      <div className="more-row">
        <button type="button" className="link" onClick={() => actions.openFix(e)}>Fix details</button>
        <button type="button" className="link" onClick={() => actions.openDetails(e)}>{hasDetails ? 'Edit what I bought' : 'Add what I bought'}</button>
        {e.source === 'statement' && (
          <button type="button" className="link" disabled={busy === 'transfer'} onClick={() => run('transfer', () => actions.setTransfer(e, !e.transfer))}>
            {e.transfer ? 'Count as spend' : 'Not spending'}
          </button>
        )}
        <ConfirmButton className="link danger" label="Delete" confirmLabel="Tap again to delete" onConfirm={() => actions.remove(e)} />
      </div>
    </Sheet>
  );
}
