import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ConfirmButton, ScreenHead } from '../components/ui.jsx';

export default function Categories({ categories, expenses, onBack, onAdd, onDelete, notify }) {
  const [custom, setCustom] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [moving, setMoving] = useState(null); // custom category being removed that still has spends
  const [target, setTarget] = useState('General');

  useEffect(() => {
    api.categories().then((r) => setCustom(r.custom || [])).catch(() => {});
  }, [categories]);

  const counts = useMemo(() => {
    const map = new Map();
    for (const e of expenses) map.set(e.category, (map.get(e.category) || 0) + 1);
    return map;
  }, [expenses]);

  const isCustom = (c) => custom.some((x) => x.toLowerCase() === c.toLowerCase());

  const add = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(name.trim());
      setName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (category, reassignTo = null) => {
    try {
      await onDelete(category, reassignTo);
      setMoving(null);
      notify(reassignTo ? `Removed ${category} · its spends are now ${reassignTo}` : `Removed ${category}`);
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page narrow">
      <ScreenHead title="Categories" onBack={onBack} />

      <form className="card inline-form" onSubmit={add}>
        <label className="field-label" htmlFor="new-category">Add a category</label>
        <div className="row">
          <input
            id="new-category" className="input" value={name} maxLength={30}
            onChange={(e) => setName(e.target.value)} placeholder="e.g. Pets"
          />
          <button type="submit" className="btn puffy sm" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </form>

      <div className="card tx-list">
        {categories.map((c) => {
          const count = counts.get(c) || 0;
          const mine = isCustom(c);
          return (
            <div key={c} className="cat-row">
              <div className="row">
                <span><b>{c}</b> <span className="muted small">{count} spend{count === 1 ? '' : 's'}</span></span>
                {mine ? (
                  count > 0 ? (
                    <button type="button" className="link danger" onClick={() => { setMoving(c); setTarget('General'); }}>Remove</button>
                  ) : (
                    <ConfirmButton className="link danger" label="Remove" confirmLabel="Tap again" onConfirm={() => remove(c)} />
                  )
                ) : (
                  <span className="tag grey">built in</span>
                )}
              </div>
              {moving === c && (
                <div className="row wrap">
                  <label className="muted small" htmlFor={`move-${c}`}>Move its {count} spends to</label>
                  <select id={`move-${c}`} className="input select" value={target} onChange={(e) => setTarget(e.target.value)}>
                    {categories.filter((x) => x !== c).map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <button type="button" className="btn soft danger sm" onClick={() => remove(c, target)}>Move and remove</button>
                  <button type="button" className="link" onClick={() => setMoving(null)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
