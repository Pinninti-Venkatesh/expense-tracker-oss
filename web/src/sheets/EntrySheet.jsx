import { useEffect, useState } from 'react';
import { toISODate } from '../lib/analytics.js';
import { money, shortDate } from '../lib/format.js';
import { ConfirmButton, Empty, Field, Sheet } from '../components/ui.jsx';

function EditForm({ entry, peopleNames, onSave, onCancel }) {
  const [direction, setDirection] = useState(entry.direction);
  const [person, setPerson] = useState(entry.personName);
  const [amount, setAmount] = useState(String(entry.amount));
  const [date, setDate] = useState(entry.date);
  const [note, setNote] = useState(entry.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const value = Number(amount);
  const minAmount = entry.repaid || 0;
  const invalid = !person.trim() || !Number.isFinite(value) || value <= 0 || value + 0.005 < minAmount;

  const submit = async (event) => {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ direction, personName: person.trim(), amount: value, date, note: note.trim() || null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="modes">
        <button type="button" className={`mode${direction === 'lent' ? ' on' : ''}`} onClick={() => setDirection('lent')}>
          <b>They owe me</b><small>Money you lent</small>
        </button>
        <button type="button" className={`mode${direction === 'borrowed' ? ' on' : ''}`} onClick={() => setDirection('borrowed')}>
          <b>I owe them</b><small>Money you borrowed</small>
        </button>
      </div>
      <div className="grid2">
        <Field label="Person" htmlFor="entry-edit-person">
          <input id="entry-edit-person" className="input" list="entry-edit-people" value={person} onChange={(e) => setPerson(e.target.value)} />
          <datalist id="entry-edit-people">{peopleNames.map((n) => <option key={n} value={n} />)}</datalist>
        </Field>
        <Field label="Amount" htmlFor="entry-edit-amount" hint={minAmount > 0 ? `At least ${money(minAmount)}, already paid back` : null}>
          <input id="entry-edit-amount" className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </Field>
      </div>
      <div className="grid2">
        <Field label="Date" htmlFor="entry-edit-date">
          <input id="entry-edit-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="What for" htmlFor="entry-edit-note">
          <input id="entry-edit-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="action-row">
        <button type="button" className="btn soft" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn puffy" disabled={invalid || busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/** Money lent or borrowed by hand: pay-backs, edits, deletion. */
export default function EntrySheet({ entry, peopleNames = [], onClose, onRepay, onRemoveRepayment, onUpdate, onDelete, notify }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(entry ? String(entry.balance) : '');
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    if (entry) setAmount(String(entry.balance));
  }, [entry?.balance]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry) {
    return (
      <Sheet title="Money lent or borrowed" onClose={onClose}>
        <Empty title="This entry is gone">It was deleted.</Empty>
      </Sheet>
    );
  }

  const lent = entry.direction === 'lent';
  const value = Number(amount);
  const invalid = !Number.isFinite(value) || value <= 0 || value > entry.balance + 0.005;

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

  const repay = (event) => {
    event.preventDefault();
    if (invalid) return;
    run('repay', () => onRepay(entry, { amount: value, date }));
  };

  return (
    <Sheet title={lent ? `${entry.personName} owes you` : `You owe ${entry.personName}`} onClose={onClose}>
      {editing ? (
        <EditForm
          entry={entry} peopleNames={peopleNames} onCancel={() => setEditing(false)}
          onSave={async (payload) => { await onUpdate(entry, payload); setEditing(false); }}
        />
      ) : (
        <div className="stack">
          <div>
            <div className={`big num${lent ? '' : ' owe'}`}>{money(entry.balance)}</div>
            <p className="muted small">
              {money(entry.amount)} {lent ? 'lent' : 'borrowed'} on {shortDate(entry.date)}{entry.note ? ` · ${entry.note}` : ''}
            </p>
          </div>

          {entry.repayments?.length > 0 && (
            <div className="inset">
              <span className="lbl">Paid back</span>
              {entry.repayments.map((r) => (
                <div key={r.id} className="split-line">
                  <span>{shortDate(r.date)}{r.note ? ` · ${r.note}` : ''}</span>
                  <span className="split-actions">
                    <b className="num">{money(r.amount)}</b>
                    <button type="button" className="link danger" disabled={busy === r.id} onClick={() => run(r.id, () => onRemoveRepayment(entry, r.id))}>Undo</button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {entry.balance > 0.005 && (
            <form className="stack-sm" onSubmit={repay}>
              <span className="lbl">{lent ? `${entry.personName} paid you back` : `You paid ${entry.personName} back`}</span>
              <div className="grid2">
                <Field label="Amount" htmlFor="repay-amount">
                  <input id="repay-amount" className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
                </Field>
                <Field label="Date" htmlFor="repay-date">
                  <input id="repay-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
              </div>
              <button type="submit" className="btn puffy wide" disabled={invalid || busy === 'repay'}>
                {busy === 'repay' ? 'Saving…' : value >= entry.balance - 0.005 ? `Record ${money(value || 0)}, all of it` : `Record ${money(value || 0)}`}
              </button>
            </form>
          )}

          <div className="action-row">
            <button type="button" className="btn soft" onClick={() => setEditing(true)}>Edit</button>
            <ConfirmButton label="Delete" confirmLabel="Tap again to delete" onConfirm={() => run('delete', () => onDelete(entry))} />
          </div>
        </div>
      )}
    </Sheet>
  );
}
