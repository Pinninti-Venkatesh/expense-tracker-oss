import { useState } from 'react';
import { toISODate } from '../lib/analytics.js';
import CategoryChips from '../components/CategoryChips.jsx';
import { Chip, Field, Seg, Sheet } from '../components/ui.jsx';
import { LoanForm } from './LoanSheet.jsx';

const TYPES = [
  { id: 'spend', label: 'Spend' },
  { id: 'lent', label: 'They owe' },
  { id: 'borrowed', label: 'I owe' },
  { id: 'loan', label: 'Loan' },
];

// Card and bank spends arrive by themselves, so a hand-typed one is most often cash.
const PAYMENT_TYPES = ['Cash', 'UPI', 'Credit Card', 'Debit Card', 'Net Banking'];

const numeric = (v) => v.replace(/[^\d.]/g, '');
const validAmount = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const rupees = (v) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function AmountInput({ id, value, onChange }) {
  return (
    <div className="amount-wrap">
      <label className="sr-only" htmlFor={id}>Amount</label>
      <span aria-hidden="true">₹</span>
      <input
        id={id} className="amount-input num" inputMode="decimal" placeholder="0" autoComplete="off"
        value={value} onChange={(e) => onChange(numeric(e.target.value))}
      />
    </div>
  );
}

function SpendForm({ categories, onAddCategory, onSave }) {
  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [paymentType, setPaymentType] = useState('Cash');
  const [category, setCategory] = useState('General');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const valid = validAmount(amount) && merchant.trim();

  const submit = async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ amount: Number(amount), merchant: merchant.trim(), date, paymentType, category, note: note.trim() || null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <AmountInput id="add-amount" value={amount} onChange={setAmount} />
      <div className="grid2">
        <Field label="Where" htmlFor="add-merchant">
          <input id="add-merchant" className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Chaayos" />
        </Field>
        <Field label="When" htmlFor="add-date">
          <input id="add-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Paid with">
        <div className="chipset">
          {PAYMENT_TYPES.map((t) => <Chip key={t} on={paymentType === t} onClick={() => setPaymentType(t)}>{t}</Chip>)}
        </div>
      </Field>
      <Field label="Category">
        <CategoryChips
          value={category} categories={categories} suggestions={['Food', 'Groceries', 'Travel']}
          onPick={setCategory} onAddCategory={onAddCategory} idPrefix="add-cat"
        />
      </Field>
      <Field label="Note (optional)" htmlFor="add-note">
        <input id="add-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Chai with the team" />
      </Field>
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="btn puffy wide" disabled={!valid || busy}>
        {busy ? 'Adding…' : validAmount(amount) ? `Add ${rupees(amount)}` : 'Add'}
      </button>
    </form>
  );
}

function EntryForm({ direction, presetName, peopleNames, onSave }) {
  const [amount, setAmount] = useState('');
  const [person, setPerson] = useState(presetName || '');
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const lent = direction === 'lent';
  const valid = validAmount(amount) && person.trim();

  const submit = async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ direction, personName: person.trim(), amount: Number(amount), date, note: note.trim() || null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <AmountInput id={`entry-amount-${direction}`} value={amount} onChange={setAmount} />
      <Field label={lent ? 'Who owes you' : 'Who you owe'} htmlFor={`entry-person-${direction}`}>
        <input
          id={`entry-person-${direction}`} className="input" list={`entry-people-${direction}`}
          value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Ravi"
        />
        <datalist id={`entry-people-${direction}`}>
          {peopleNames.map((n) => <option key={n} value={n} />)}
        </datalist>
        {peopleNames.length > 0 && (
          <div className="chipset">
            {peopleNames.slice(0, 8).map((n) => <Chip key={n} on={person === n} onClick={() => setPerson(n)}>{n}</Chip>)}
          </div>
        )}
      </Field>
      <div className="grid2">
        <Field label="When" htmlFor={`entry-date-${direction}`}>
          <input id={`entry-date-${direction}`} type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="What for (optional)" htmlFor={`entry-note-${direction}`}>
          <input id={`entry-note-${direction}`} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Rent" />
        </Field>
      </div>
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="btn puffy wide" disabled={!valid || busy}>
        {busy ? 'Saving…' : valid ? (lent ? `${person.trim()} owes you ${rupees(amount)}` : `You owe ${person.trim()} ${rupees(amount)}`) : 'Save'}
      </button>
    </form>
  );
}

/** One + for everything typed by hand: a spend, money lent, money borrowed, or a loan. */
export default function AddSheet({
  initialType = 'spend', presetName = '', categories, peopleNames = [], onAddCategory, onClose,
  onAddSpend, onAddEntry, onAddLoan,
}) {
  const [type, setType] = useState(initialType);

  return (
    <Sheet title="Add" onClose={onClose}>
      <Seg label="What to add" options={TYPES} value={type} onChange={setType} />
      {type === 'spend' && <SpendForm categories={categories} onAddCategory={onAddCategory} onSave={onAddSpend} />}
      {(type === 'lent' || type === 'borrowed') && (
        <EntryForm key={type} direction={type} presetName={presetName} peopleNames={peopleNames} onSave={onAddEntry} />
      )}
      {type === 'loan' && <LoanForm onSave={onAddLoan} />}
    </Sheet>
  );
}
