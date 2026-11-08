import { useState } from 'react';
import { Chip } from './ui.jsx';

/**
 * One-tap category choice: a handful of likely categories as chips, and "More…"
 * for the full list with search and "+ Add". The quick chips keep their order
 * while you tap, so nothing jumps under your finger.
 */
export default function CategoryChips({
  value, categories = [], suggestions = [], onPick, onAddCategory, disabled, idPrefix = 'cat',
}) {
  const [quick] = useState(() => [...new Set([value, ...suggestions, ...categories].filter(Boolean))].slice(0, 5));
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const shown = !value || quick.includes(value) ? quick : [value, ...quick.slice(0, 4)];
  const q = query.trim();
  const filtered = categories.filter((c) => !q || c.toLowerCase().includes(q.toLowerCase()));
  const canCreate = Boolean(onAddCategory) && q.length > 0 && !categories.some((c) => c.toLowerCase() === q.toLowerCase());

  const choose = (c) => {
    onPick(c);
    setMore(false);
    setQuery('');
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      choose(await onAddCategory(q));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cat-chips">
      <div className="chipset">
        {shown.map((c) => (
          <Chip key={c} on={c === value} onClick={() => onPick(c)} disabled={disabled}>{c}</Chip>
        ))}
        <Chip on={more} onClick={() => setMore((m) => !m)}>{more ? 'Fewer' : 'More…'}</Chip>
      </div>

      {more && (
        <div className="cat-more">
          <input
            id={`${idPrefix}-search`} className="input" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or add a category" aria-label="Search categories"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (filtered.length === 1) choose(filtered[0]);
              else if (canCreate) create();
            }}
          />
          <div className="chipset">
            {filtered.map((c) => (
              <Chip key={c} on={c === value} onClick={() => choose(c)} disabled={disabled}>{c}</Chip>
            ))}
            {canCreate && <Chip onClick={create} disabled={busy}>{busy ? 'Adding…' : `+ Add “${q}”`}</Chip>}
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </div>
  );
}
