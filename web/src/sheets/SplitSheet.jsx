import { useMemo, useState } from 'react';
import { money } from '../lib/format.js';
import { Avatar, Chip, ConfirmButton, Sheet } from '../components/ui.jsx';

const MODES = [
  { id: 'equal', label: 'Equally', hint: 'Evenly between you and them' },
  { id: 'shares', label: 'Shares', hint: '2 shares pays twice as much' },
  { id: 'exact', label: 'Exact', hint: 'Type what each person owes' },
  { id: 'lent', label: 'Lent it all', hint: 'None of it is yours' },
];

/** Mirrors server/splits.js so the preview matches exactly what gets saved. */
function preview({ total, mode, rows, includeYou }) {
  const cents = Math.round(Number(total) * 100);
  if (!rows.length || cents <= 0) return null;

  let owed;
  if (mode === 'equal') {
    const each = Math.floor(cents / (rows.length + (includeYou ? 1 : 0)));
    owed = rows.map(() => each);
  } else if (mode === 'lent') {
    const each = Math.floor(cents / rows.length);
    owed = rows.map(() => each);
  } else if (mode === 'shares') {
    const w = rows.map((p) => Number(p.shares) || 0);
    if (w.some((x) => x <= 0)) return { error: 'Every person needs at least 1 share' };
    const totalW = w.reduce((a, b) => a + b, 0) + (includeYou ? 1 : 0);
    owed = w.map((x) => Math.floor((cents * x) / totalW));
  } else {
    owed = rows.map((p) => Math.round((Number(p.owed) || 0) * 100));
    if (owed.reduce((a, b) => a + b, 0) > cents) return { error: 'That adds up to more than the spend' };
  }

  const sum = owed.reduce((a, b) => a + b, 0);
  return { yourShare: (cents - sum) / 100, rows: rows.map((p, i) => ({ name: p.name, owed: owed[i] / 100 })) };
}

export default function SplitSheet({ expense, peopleNames = [], onClose, onSave, onRemove }) {
  const [mode, setMode] = useState(expense?.split?.mode || 'equal');
  const [rows, setRows] = useState(() => (expense?.split?.participants || []).map((p) => ({
    id: p.id, status: p.status, name: p.name, shares: p.shares || 1, owed: p.owed,
  })));
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const includeYou = mode !== 'lent';
  const result = useMemo(
    () => (expense ? preview({ total: expense.amount, mode, rows, includeYou }) : null),
    [expense, mode, rows, includeYou],
  );

  if (!expense) return null;

  const has = (name) => rows.some((r) => r.name.toLowerCase() === name.toLowerCase());
  const toggle = (name) => setRows((rs) => (has(name)
    ? rs.filter((r) => r.name.toLowerCase() !== name.toLowerCase())
    : [...rs, { name, shares: 1, owed: '' }]));
  const addNew = () => {
    const name = newName.trim();
    if (!name) return;
    if (!has(name)) setRows((rs) => [...rs, { name, shares: 1, owed: '' }]);
    setNewName('');
  };
  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const known = [...new Set([...peopleNames, ...rows.map((r) => r.name)])];
  const valid = result && !result.error && rows.length > 0;

  const submit = async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        mode,
        includeYou,
        participants: rows.map((r) => ({
          ...(r.id && { id: r.id }),
          ...(r.status && { status: r.status }),
          name: r.name,
          shares: Number(r.shares) || 1,
          owed: Number(r.owed) || 0,
        })),
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Split ${expense.merchant} · ${money(expense.amount)}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="modes">
          {MODES.map((m) => (
            <button key={m.id} type="button" className={`mode${mode === m.id ? ' on' : ''}`} onClick={() => setMode(m.id)} aria-pressed={mode === m.id}>
              <b>{m.label}</b><small>{m.hint}</small>
            </button>
          ))}
        </div>

        <span className="lbl">With</span>
        {known.length > 0 && (
          <div className="chipset">
            {known.map((name) => (
              <Chip key={name} on={has(name)} onClick={() => toggle(name)}>
                <Avatar name={name} round size={20} />{name}{has(name) ? ' ✓' : ''}
              </Chip>
            ))}
          </div>
        )}
        <div className="row">
          <input
            id="split-new-person" className="input" value={newName} placeholder="Someone new"
            aria-label="Add someone new" onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } }}
          />
          <button type="button" className="btn soft sm" onClick={addNew} disabled={!newName.trim()}>Add</button>
        </div>

        {(mode === 'shares' || mode === 'exact') && rows.length > 0 && (
          <div className="inset">
            {rows.map((r, i) => (
              <div key={r.name} className="split-line">
                <label htmlFor={`split-${mode}-${i}`}>{r.name}</label>
                <input
                  id={`split-${mode}-${i}`} className="input narrow num" inputMode="decimal"
                  placeholder={mode === 'shares' ? 'Shares' : 'Amount'}
                  value={mode === 'shares' ? r.shares : r.owed}
                  onChange={(e) => setRow(i, { [mode === 'shares' ? 'shares' : 'owed']: e.target.value.replace(/[^\d.]/g, '') })}
                />
              </div>
            ))}
          </div>
        )}

        {result?.error && <p className="error-text">{result.error}</p>}
        {result && !result.error && (
          <div className="inset">
            <div className="split-line"><span>You{mode === 'lent' ? ' (paid, owe nothing)' : ''}</span><b className="num">{money(result.yourShare)}</b></div>
            {result.rows.map((r) => (
              <div key={r.name} className="split-line"><span>{r.name} owes you</span><b className="num accent">{money(r.owed)}</b></div>
            ))}
          </div>
        )}
        {!rows.length && <p className="muted small">Pick who was there, or add someone new.</p>}
        {error && <p className="error-text">{error}</p>}

        <button type="submit" className="btn puffy wide" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save split'}</button>
        {expense.split && (
          <ConfirmButton className="btn soft danger wide" label="Remove split" confirmLabel="Tap again to remove the split" onConfirm={onRemove} />
        )}
      </form>
    </Sheet>
  );
}
