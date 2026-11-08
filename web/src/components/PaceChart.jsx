import { money, moneyShort } from '../lib/format.js';

// Room on the right for last month's end label; below for the day axis.
const W = 320;
const H = 124;
const L = 8;
const R = 70;
const T = 16;
const B = 22;

/**
 * Spent so far this month against last month, on the same day axis. Last month
 * is dashed and grey so it reads as a reference line, not a second dataset.
 */
export default function PaceChart({ comparison }) {
  const { current, previous, today, soFar, previousAtSameDay, previousTotal, hasPrevious, previousLabel } = comparison;
  const days = current.length - 1;
  const prevDays = previous.length - 1;
  const span = Math.max(days, hasPrevious ? prevDays : 0, 2);
  const peak = Math.max(soFar, hasPrevious ? previousTotal : 0, 1);

  const x = (d) => L + ((d - 1) / (span - 1)) * (W - L - R);
  const y = (v) => H - B - (v / peak) * (H - T - B);
  const path = (curve, upto) =>
    Array.from({ length: upto }, (_, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)} ${y(curve[i + 1] || 0).toFixed(1)}`).join(' ');

  const upto = Math.max(1, today);
  const nowPath = path(current, upto);
  const area = upto > 1 ? `${nowPath} L${x(upto).toFixed(1)} ${y(0).toFixed(1)} L${x(1).toFixed(1)} ${y(0).toFixed(1)} Z` : null;

  const dotX = x(upto);
  const dotY = y(soFar);
  const nowLabelY = dotY < (T + H - B) / 2 ? dotY + 15 : dotY - 9;
  const nearRight = dotX > (W - R) * 0.72;

  const prevEndY = Math.min(Math.max(y(previousTotal) + 4, T), H - B - 2);
  const showToday = upto > 3 && upto < span - 3;

  const label = hasPrevious
    ? `${money(soFar)} by day ${upto}. ${previousLabel} was ${money(previousAtSameDay)} at this point and ended at ${money(previousTotal)}.`
    : `${money(soFar)} by day ${upto}.`;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <line className="ax" x1={L} y1={y(0)} x2={W - R} y2={y(0)} />
      {hasPrevious && (
        <>
          <path className="prev" d={path(previous, prevDays)} />
          <text className="lab" x={x(prevDays) + 5} y={prevEndY}>{`${previousLabel.slice(0, 3)} ${moneyShort(previousTotal)}`}</text>
        </>
      )}
      {area && <path className="area" d={area} />}
      <path className="now" d={nowPath} />
      <circle className="dotn" cx={dotX} cy={dotY} r="3.6" />
      <text className="lab now" x={nearRight ? dotX - 7 : dotX + 7} y={nowLabelY} textAnchor={nearRight ? 'end' : 'start'}>
        {moneyShort(soFar)}
      </text>
      <text className="lab" x={L} y={H - 6}>1</text>
      {showToday && <text className="lab" x={dotX} y={H - 6} textAnchor="middle">{upto}</text>}
      <text className="lab" x={W - R} y={H - 6} textAnchor="end">{span}</text>
    </svg>
  );
}
