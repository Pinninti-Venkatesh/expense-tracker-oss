import { useMemo, useState } from 'react';
import { PROPAGATABLE, siblingsOf } from '../lib/analytics.js';
import { money } from '../lib/format.js';
import CategoryChips from '../components/CategoryChips.jsx';
import { Chip, Field, Sheet, Toggle } from '../components/ui.jsx';

/**
 * Reasons one tap away. The reason is what the extractor learns from, so it is
 * still required — but nobody has to type it. A chip can also fill in the fix.
 */
const REASONS = [
  { id: 'fee', label: "It's a fee", text: 'This is a fee or charge, not a purchase.' },
  { id: 'refund', label: "It's a refund", text: 'This is a refund or reversal, not a spend.', patch: { isExpense: false } },
  { id: 'duplicate', label: "It's a duplicate", text: 'This is a duplicate alert for a charge already recorded.', patch: { isExpense: false } },
  { id: 'amount', label: 'Wrong amount', text: 'The amount was read wrong.' },
  { id: 'merchant', label: 'Wrong place name', text: 'The place name was read wrong.' },
  { id: 'category', label: 'Wrong category', text: 'The category was wrong.' },
];

export default function FixSheet({ expense, categories, allExpenses, onAddCategory, onClose, onSave }) {
  const [reasonId, setReasonId] = useState(null);
  const [extra, setExtra] = useState('');
  const [corrected, setCorrected] = useState({});
  const [applyToAll, setApplyToAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const siblings = useMemo(() => (expense ? siblingsOf(allExpenses, expense).count : 0), [allExpenses, expense]);

  if (!expense) return null;

  const original = (field) => (field === 'isExpense' ? expense.isExpense !== false : expense[field]);
  const change = (field, value) => setCorrected((c) => {
    const next = { ...c };
    if (value === '' || value === original(field)) delete next[field];
    else next[field] = value;
    return next;
  });
  const valueOf = (field) => (field in corrected ? corrected[field] : original(field));

  const chooseReason = (r) => {
    const turningOn = reasonId !== r.id;
    setReasonId(turningOn ? r.id : null);
    if (turningOn && r.patch) Object.entries(r.patch).forEach(([k, v]) => change(k, v));
  };

  const reason = [REASONS.find((r) => r.id === reasonId)?.text, extra.trim()].filter(Boolean).join(' ');
  const changed = Object.keys(corrected);
  const propagatable = changed.filter((f) => PROPAGATABLE.includes(f));
  const offerRetro = propagatable.length > 0 && siblings > 0;
  const categoryOnly = changed.length === 1 && changed[0] === 'category';
  const valid = Boolean(reason) && changed.length > 0;

  const submit = async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(reason, corrected, offerRetro && applyToAll);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Sheet title="Fix details" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">{expense.merchant} · {money(expense.amount)} · {expense.category}</p>

        <Field label="What's wrong?">
          <div className="chipset">
            {REASONS.map((r) => <Chip key={r.id} on={reasonId === r.id} onClick={() => chooseReason(r)}>{r.label}</Chip>)}
          </div>
        </Field>
        <Field label="Anything else? (optional)" htmlFor="fix-extra">
          <textarea
            id="fix-extra" className="input" rows={2} value={extra} onChange={(e) => setExtra(e.target.value)}
            placeholder="e.g. Zepto is groceries, not eating out"
          />
        </Field>

        <span className="lbl">Correct it</span>
        <Field label="Category">
          <CategoryChips
            value={valueOf('category')} categories={categories} onPick={(c) => change('category', c)}
            onAddCategory={onAddCategory} idPrefix="fix-cat"
          />
        </Field>
        <div className="grid2">
          <Field label="Place name" htmlFor="fix-merchant">
            <input id="fix-merchant" className="input" value={valueOf('merchant')} onChange={(e) => change('merchant', e.target.value)} />
          </Field>
          <Field label="Amount" htmlFor="fix-amount">
            <input
              id="fix-amount" className="input num" inputMode="decimal" value={valueOf('amount')}
              onChange={(e) => change('amount', e.target.value === '' ? '' : Number(e.target.value.replace(/[^\d.]/g, '')))}
            />
          </Field>
        </div>
        <div className="toggle-row">
          <label htmlFor="fix-not-expense">Not a real spend (fee, refund, duplicate)</label>
          <Toggle id="fix-not-expense" checked={valueOf('isExpense') === false} onChange={(on) => change('isExpense', !on)} label="Not a real spend" />
        </div>

        {offerRetro && (
          <div className="toggle-row">
            <label htmlFor="fix-all">Also fix the other {siblings} {expense.merchant} spend{siblings === 1 ? '' : 's'}</label>
            <Toggle id="fix-all" checked={applyToAll} onChange={setApplyToAll} label="Also fix past spends" />
          </div>
        )}

        {changed.length > 0 && (
          <p className="notice">
            {categoryOnly
              ? `A rule is saved: ${valueOf('merchant')} is always ${corrected.category}.`
              : 'This becomes an example the app reads before new alerts, so it gets similar ones right.'}
          </p>
        )}

        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn puffy wide" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save and learn'}</button>
        {!valid && (
          <p className="muted small center">{!reason ? 'Pick what was wrong, then correct it above.' : 'Change at least one detail above.'}</p>
        )}
      </form>
    </Sheet>
  );
}
