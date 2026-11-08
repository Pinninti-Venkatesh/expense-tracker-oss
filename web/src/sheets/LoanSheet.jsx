import { useMemo, useState } from 'react';
import { toISODate } from '../lib/analytics.js';
import { money } from '../lib/format.js';
import { Chip, Field, Sheet } from '../components/ui.jsx';

const TYPES = [
  { id: 'home', label: 'Home', rateType: 'floating' },
  { id: 'car', label: 'Car', rateType: 'fixed' },
  { id: 'personal', label: 'Personal', rateType: 'fixed' },
  { id: 'education', label: 'Education', rateType: 'floating' },
  { id: 'gold', label: 'Gold', rateType: 'fixed' },
  { id: 'lap', label: 'Property', rateType: 'floating' },
  { id: 'other', label: 'Other', rateType: 'fixed' },
];

const TENURES = [12, 36, 60, 84, 120, 180, 240, 360];

/** Mirrors computeEmi in server/loans.js, so the figure updates as you type. */
function emiFor(principal, rate, months) {
  const P = Number(principal);
  const n = Math.round(Number(months));
  const r = Number(rate) / 1200;
  if (!(P > 0) || !(n > 0)) return 0;
  if (r === 0) return P / n;
  const f = (1 + r) ** n;
  return (P * r * f) / (f - 1);
}

const yearsLabel = (m) => {
  const n = Math.round(Number(m) || 0);
  if (!n) return '';
  const y = Math.floor(n / 12);
  const rem = n % 12;
  return [y && `${y}y`, rem && `${rem}m`].filter(Boolean).join(' ');
};

const numeric = (v) => v.replace(/[^\d.]/g, '');

/**
 * Add or edit a loan: type, amount, rate and tenure up front, with the EMI
 * working itself out as you type. The lender's own balance, first EMI date,
 * actual EMI and closing charge sit under "More options".
 */
export function LoanForm({ loan, onSave }) {
  const editing = Boolean(loan);
  const [form, setForm] = useState({
    name: loan?.name || '',
    lender: loan?.lender || '',
    type: loan?.type || 'home',
    rateType: loan?.rateType || 'floating',
    principal: loan ? String(loan.principal) : '',
    annualRate: loan ? String(loan.annualRate) : '',
    tenureMonths: loan ? String(loan.tenureMonths) : '240',
    startDate: loan?.startDate || toISODate(new Date()),
    emi: loan?.emi ? String(loan.emi) : '',
    foreclosurePct: loan?.foreclosurePct != null ? String(loan.foreclosurePct) : '',
    firstEmiDate: loan?.firstEmiDate || '',
    outstandingOverride: loan?.outstandingOverride != null ? String(loan.outstandingOverride) : '',
    outstandingAsOf: loan?.outstandingAsOf || toISODate(new Date()),
  });
  const [advanced, setAdvanced] = useState(Boolean(loan?.firstEmiDate || loan?.outstandingOverride != null || loan?.emi));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const type = TYPES.find((t) => t.id === form.type) || TYPES[0];

  const computedEmi = useMemo(
    () => emiFor(form.principal, form.annualRate, form.tenureMonths),
    [form.principal, form.annualRate, form.tenureMonths],
  );
  const effectiveEmi = Number(form.emi) > 0 ? Number(form.emi) : computedEmi;
  const totalPayable = effectiveEmi * Math.round(Number(form.tenureMonths) || 0);
  const totalInterest = Math.max(0, totalPayable - Number(form.principal || 0));

  const invalid = !(Number(form.principal) > 0) || form.annualRate === '' || !(Number(form.annualRate) >= 0)
    || !(Number(form.tenureMonths) > 0) || !form.startDate;

  const submit = async (event) => {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        ...form,
        name: form.name.trim() || `${type.label} loan`,
        principal: Number(form.principal),
        annualRate: Number(form.annualRate),
        tenureMonths: Math.round(Number(form.tenureMonths)),
        emi: Number(form.emi) > 0 ? Number(form.emi) : null,
        foreclosurePct: form.foreclosurePct === '' ? null : Number(form.foreclosurePct),
        firstEmiDate: form.firstEmiDate || null,
        outstandingOverride: form.outstandingOverride === '' ? null : Number(form.outstandingOverride),
        outstandingAsOf: form.outstandingOverride === '' ? null : form.outstandingAsOf,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="chipset" role="group" aria-label="Loan type">
        {TYPES.map((t) => (
          <Chip key={t.id} on={form.type === t.id} onClick={() => setForm((f) => ({ ...f, type: t.id, rateType: t.rateType }))}>
            {t.label}
          </Chip>
        ))}
      </div>

      <div className="grid2">
        <Field label="Amount borrowed" htmlFor="loan-principal">
          <input
            id="loan-principal" className="input num" inputMode="decimal" placeholder="50,00,000"
            value={form.principal} onChange={(e) => set('principal', numeric(e.target.value))}
          />
        </Field>
        <Field label="Rate a year (%)" htmlFor="loan-rate">
          <input
            id="loan-rate" className="input num" inputMode="decimal" placeholder="8.5"
            value={form.annualRate} onChange={(e) => set('annualRate', numeric(e.target.value))}
          />
        </Field>
      </div>

      <div className="grid2">
        <Field label="Name" htmlFor="loan-name">
          <input id="loan-name" className="input" placeholder={`${type.label} loan`} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Lender" htmlFor="loan-lender">
          <input id="loan-lender" className="input" placeholder="HDFC Bank" value={form.lender} onChange={(e) => set('lender', e.target.value)} />
        </Field>
      </div>

      <Field label="Started (disbursal date)" htmlFor="loan-start" hint="The first EMI is taken as one month later, unless you set it under More options.">
        <input id="loan-start" type="date" className="input" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
      </Field>

      <Field label={`Tenure${form.tenureMonths ? ` · ${yearsLabel(form.tenureMonths)}` : ''}`} htmlFor="loan-tenure">
        <div className="chipset">
          {TENURES.map((m) => (
            <Chip key={m} on={Number(form.tenureMonths) === m} onClick={() => set('tenureMonths', String(m))}>{yearsLabel(m)}</Chip>
          ))}
        </div>
        <input
          id="loan-tenure" className="input num" inputMode="numeric" aria-label="Tenure in months"
          value={form.tenureMonths} onChange={(e) => set('tenureMonths', e.target.value.replace(/\D/g, ''))}
        />
      </Field>

      <div className="modes">
        <button type="button" className={`mode${form.rateType === 'floating' ? ' on' : ''}`} onClick={() => set('rateType', 'floating')}>
          <b>Floating rate</b><small>Moves with the repo rate. No charge to close early.</small>
        </button>
        <button type="button" className={`mode${form.rateType === 'fixed' ? ' on' : ''}`} onClick={() => set('rateType', 'fixed')}>
          <b>Fixed rate</b><small>Locked for the tenure. A closing charge applies.</small>
        </button>
      </div>

      {computedEmi > 0 && (
        <div className="glass">
          <div className="row">
            <span className="glass-label">Monthly EMI</span>
            <span className="glass-big num">{money(effectiveEmi)}</span>
          </div>
          <span className="glass-sub">{money(totalPayable)} over {yearsLabel(form.tenureMonths)}, of which {money(totalInterest)} is interest.</span>
        </div>
      )}

      <button type="button" className="link" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
        {advanced ? 'Fewer options' : 'More options'}
      </button>

      {advanced && (
        <div className="stack">
          <Field label="First EMI date" htmlFor="loan-first-emi" hint="If your lender bills on a fixed day that isn't a month after disbursal.">
            <input
              id="loan-first-emi" type="date" className="input" min={form.startDate}
              value={form.firstEmiDate} onChange={(e) => set('firstEmiDate', e.target.value)}
            />
          </Field>
          <div className="grid2">
            <Field label="Balance from your bank" htmlFor="loan-outstanding" hint="Makes your lender's figure the source of truth.">
              <input
                id="loan-outstanding" className="input num" inputMode="decimal" placeholder="Optional"
                value={form.outstandingOverride} onChange={(e) => set('outstandingOverride', numeric(e.target.value))}
              />
            </Field>
            <Field label="Balance read on" htmlFor="loan-outstanding-date">
              <input
                id="loan-outstanding-date" type="date" className="input" disabled={form.outstandingOverride === ''}
                value={form.outstandingAsOf} onChange={(e) => set('outstandingAsOf', e.target.value)}
              />
            </Field>
          </div>
          <div className="grid2">
            <Field label="Actual EMI" htmlFor="loan-emi" hint="If your bank's figure differs.">
              <input
                id="loan-emi" className="input num" inputMode="decimal" placeholder={computedEmi ? String(Math.round(computedEmi)) : ''}
                value={form.emi} onChange={(e) => set('emi', numeric(e.target.value))}
              />
            </Field>
            <Field label="Closing charge %" htmlFor="loan-foreclosure">
              <input
                id="loan-foreclosure" className="input num" inputMode="decimal" placeholder={form.rateType === 'floating' ? '0' : '3'}
                value={form.foreclosurePct} onChange={(e) => set('foreclosurePct', numeric(e.target.value))}
              />
            </Field>
          </div>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      <button type="submit" className="btn puffy wide" disabled={busy || invalid}>
        {busy ? 'Saving…' : editing ? 'Save loan' : 'Add loan'}
      </button>
    </form>
  );
}

export default function LoanSheet({ loan, onClose, onSave }) {
  return (
    <Sheet title={loan ? 'Edit loan' : 'Add a loan'} onClose={onClose}>
      <LoanForm loan={loan} onSave={onSave} />
    </Sheet>
  );
}
