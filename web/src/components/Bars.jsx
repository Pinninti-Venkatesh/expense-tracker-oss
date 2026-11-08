import { money } from '../lib/format.js';

/** Horizontal bars on one scale. Rows become buttons when they can filter something. */
export default function Bars({ rows, onPick, selected, format = money }) {
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <div className="bars">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="bar-label">{r.label}</span>
            <span className="bar-track"><i style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} /></span>
            <span className="bar-value num">{format(r.value)}</span>
          </>
        );
        return onPick ? (
          <button
            type="button" key={r.id} className={`bar-row${selected === r.id ? ' on' : ''}`}
            onClick={() => onPick(r.id)} aria-pressed={selected === r.id}
          >
            {inner}
          </button>
        ) : (
          <div key={r.id} className="bar-row">{inner}</div>
        );
      })}
    </div>
  );
}
