import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatMonthYear, money, shortDate } from '../lib/format.js';
import { ConfirmButton, Empty, ScreenHead } from '../components/ui.jsx';

/** "2 years 6 months" */
function timeLeft(n) {
  if (n <= 0) return 'Done';
  const y = Math.floor(n / 12);
  const m = n % 12;
  return [y && `${y} year${y === 1 ? '' : 's'}`, m && `${m} month${m === 1 ? '' : 's'}`].filter(Boolean).join(' ');
}

const dueLabel = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });

export default function LoanDetail({ loan, onBack, onEdit, onDelete }) {
  const [schedule, setSchedule] = useState(null);
  const [full, setFull] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!loan) return undefined;
    let live = true;
    setError(null);
    api.loanSchedule(loan.id)
      .then((r) => { if (live) setSchedule(r); })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [loan?.id, loan?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loan) {
    return (
      <div className="page">
        <ScreenHead title="Loan" onBack={onBack} />
        <Empty title="This loan is gone">It was deleted.</Empty>
      </div>
    );
  }

  const c = loan.computed;
  const pc = c.preclosure;
  const next = schedule ? schedule.rows.filter((r) => !r.paid).slice(0, 3) : [];
  const rows = full ? schedule?.rows || [] : next;

  return (
    <div className="page">
      <ScreenHead
        title={loan.name}
        onBack={onBack}
        right={<button type="button" className="link" onClick={() => onEdit(loan)}>Edit</button>}
      />

      <section className="hero">
        <span className="hero-label">Still owed{loan.lender ? ` · ${loan.lender}` : ''} · {loan.annualRate}% {loan.rateType}</span>
        <div className="big num">{money(c.outstanding)}</div>
        {c.anchored && (
          <span className="muted small">From your bank&apos;s balance on {shortDate(loan.outstandingAsOf)}, moved on by each EMI since.</span>
        )}
      </section>

      <div className="detail-grid">
        <section className="card">
          {c.closed ? (
            <p className="muted">Fully repaid.</p>
          ) : (
            <>
              <span className="meter"><i style={{ width: `${Math.max(1, c.percentPaid)}%` }} /></span>
              <span className="muted small">{Math.round(c.percentPaid)}% of the loan repaid · {c.paymentsMade} of {c.tenureMonths} EMIs</span>
            </>
          )}
          <dl className="kv">
            <div><dt>Monthly EMI</dt><dd className="num">{money(c.emi)}</dd></div>
            <div><dt>Time left</dt><dd>{timeLeft(c.paymentsLeft)}</dd></div>
            <div><dt>Closes on</dt><dd>{formatMonthYear(c.payoffDate) || '—'}</dd></div>
            <div><dt>Interest left</dt><dd className="warn num">{money(c.interestLeft)}</dd></div>
            <div><dt>Borrowed</dt><dd className="num">{money(loan.principal)}</dd></div>
            <div><dt>Interest paid</dt><dd className="num">{money(c.interestPaid)}</dd></div>
          </dl>
        </section>

        {!c.closed && (
          <section className="glass">
            <span className="glass-label">Close it today</span>
            <div className="glass-big num">{money(pc.total)}</div>
            <span className="glass-sub">
              {money(pc.outstanding)} principal
              {pc.chargeFree
                ? ' · no closing charge on a floating rate (RBI rule)'
                : ` · ${pc.chargePct}% charge ${money(pc.charge)} + GST ${money(pc.gst)}`}
            </span>
            <b className="glass-accent">
              {pc.saving > 0
                ? `Saves ${money(pc.saving)} in interest${pc.chargeFree ? '' : ' after charges'}`
                : 'Closing now costs more in charges than it saves'}
            </b>
          </section>
        )}

        <section className="card span-2">
          <div className="card-head">
            <h2>{full ? 'Full schedule' : 'Next EMIs'}</h2>
            {schedule && (
              <button type="button" className="link" onClick={() => setFull((f) => !f)}>
                {full ? 'Show next 3' : 'Full schedule'}
              </button>
            )}
          </div>
          {error && <p className="error-text">{error}</p>}
          {!schedule && !error && <p className="muted small">Loading…</p>}
          {schedule && !rows.length && <p className="muted small">Every EMI has fallen due.</p>}
          {schedule && rows.length > 0 && (
            <div className="table-scroll">
              <table className="sched num">
                <thead>
                  <tr><th>#</th><th>Due</th><th>Interest</th><th>Principal</th><th>Left</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.n} className={r.paid ? 'paid' : ''}>
                      <td>{r.n}</td>
                      <td>{dueLabel(r.date)}</td>
                      <td>{money(r.interest)}</td>
                      <td>{money(r.principal)}</td>
                      <td>{money(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {full && <p className="muted small">Shaded rows have fallen due. Compare the balance with your bank statement.</p>}
        </section>
      </div>

      <ConfirmButton
        className="btn soft danger wide" label="Delete this loan" confirmLabel="Tap again to delete"
        onConfirm={() => onDelete(loan)}
      />
    </div>
  );
}
