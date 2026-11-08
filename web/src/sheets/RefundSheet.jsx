import { useState } from 'react';
import { refundedTotal, toISODate } from '../lib/analytics.js';
import { money } from '../lib/format.js';
import { Field, Sheet } from '../components/ui.jsx';

/** A refund against a charge. Prefilled with everything not yet refunded. */
export default function RefundSheet({ expense, onClose, onSave }) {
  const charged = Number(expense?.amount) || 0;
  const already = expense ? refundedTotal(expense) : 0;
  const remaining = Math.round((charged - already) * 100) / 100;

  const [amount, setAmount] = useState(String(remaining));
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!expense) return null;

  const value = Number(amount);
  const invalid = !Number.isFinite(value) || value <= 0 || value > remaining + 0.005;

  const submit = async (event) => {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ amount: value, date, note: note.trim() || null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Refund from ${expense.merchant}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">Charged {money(charged)}{already > 0 ? ` · ${money(already)} already refunded` : ''}</p>
        <Field label="Refund amount" htmlFor="refund-amount" hint={`Up to ${money(remaining)}. Change it for a partial return.`}>
          <input
            id="refund-amount" className="input num" inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </Field>
        <div className="grid2">
          <Field label="Date" htmlFor="refund-date">
            <input id="refund-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Note" htmlFor="refund-note">
            <input id="refund-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Returned the shirt" />
          </Field>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn puffy wide" disabled={busy || invalid}>
          {busy ? 'Saving…' : `Record ${money(value || 0)} refund`}
        </button>
      </form>
    </Sheet>
  );
}
