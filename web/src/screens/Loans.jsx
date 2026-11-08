import { formatMonthYear, money } from '../lib/format.js';
import { Empty, Icon, ScreenHead } from '../components/ui.jsx';

function LoanCard({ loan, onOpen }) {
  const c = loan.computed;
  return (
    <button type="button" className="card loan-card" onClick={onOpen}>
      <div className="row">
        <span className="ttl">{loan.name} <span className="badge grey">{loan.rateType}</span></span>
        <span className="muted small">{loan.lender || ''}</span>
      </div>
      {c.closed ? (
        <p className="muted small">Fully repaid · {money(loan.principal)} at {loan.annualRate}%</p>
      ) : (
        <>
          <div className="row end">
            <span className="mid num">{money(c.outstanding)}</span>
            <span className="muted small num">{money(c.emi)} EMI</span>
          </div>
          <span className="meter"><i style={{ width: `${Math.max(1, c.percentPaid)}%` }} /></span>
          <div className="row">
            <span className="muted small">{Math.round(c.percentPaid)}% repaid · {c.paymentsMade} of {c.tenureMonths} EMIs</span>
            <span className="muted small">ends {formatMonthYear(c.payoffDate)}</span>
          </div>
        </>
      )}
    </button>
  );
}

export default function Loans({ data, onOpenLoan, onAdd }) {
  const addButton = (
    <button type="button" className="icon-btn" onClick={onAdd} aria-label="Add a loan"><Icon name="plus" /></button>
  );

  if (!data) {
    return (
      <div className="page">
        <ScreenHead title="Loans" right={addButton} />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const { loans = [], totalOutstanding, totalMonthlyEmi, totalInterestLeft, debtFreeBy } = data;

  return (
    <div className="page">
      <ScreenHead title="Loans" right={addButton} />

      {!loans.length ? (
        <Empty title="No loans yet" action={<button type="button" className="btn puffy" onClick={onAdd}>Add a loan</button>}>
          Add a loan&apos;s amount, rate, tenure and start date. The EMI, what&apos;s left and what closing early costs are worked out for you.
        </Empty>
      ) : (
        <>
          <section className="hero">
            <span className="hero-label">Still owed</span>
            <div className="big num">{money(totalOutstanding)}</div>
            <div className="chipset">
              <span className="tag">{money(totalMonthlyEmi)} a month</span>
              {debtFreeBy && <span className="tag good">Debt-free {formatMonthYear(debtFreeBy)}</span>}
            </div>
          </section>

          <div className="loan-grid">
            {loans.map((l) => <LoanCard key={l.id} loan={l} onOpen={() => onOpenLoan(l.id)} />)}
          </div>

          {totalInterestLeft > 0 && (
            <section className="glass">
              <span className="glass-label">Interest still to pay</span>
              <div className="glass-big num">{money(totalInterestLeft)}</div>
              <span className="glass-sub">If rates hold and every EMI is paid on time. Floating rates move with the repo rate.</span>
            </section>
          )}
        </>
      )}
    </div>
  );
}
