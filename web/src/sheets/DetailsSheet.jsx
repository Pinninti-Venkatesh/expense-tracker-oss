import { useState } from 'react';
import { Field, Sheet } from '../components/ui.jsx';

/** What was bought, by hand: a line about it and items one per line. */
export default function DetailsSheet({ expense, onClose, onSave }) {
  const [description, setDescription] = useState(expense?.description || '');
  const [itemsText, setItemsText] = useState((expense?.items || []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!expense) return null;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const items = itemsText.split('\n').map((i) => i.trim()).filter(Boolean);
      await onSave({ description: description.trim() || null, items });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Sheet title="What you bought" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">{expense.merchant}</p>
        <Field label="What was it?" htmlFor="details-description">
          <textarea
            id="details-description" className="input" rows={2} value={description}
            onChange={(e) => setDescription(e.target.value)} placeholder="Monthly grocery run"
          />
        </Field>
        <Field label="Items (optional, one per line)" htmlFor="details-items">
          <textarea
            id="details-items" className="input" rows={4} value={itemsText}
            onChange={(e) => setItemsText(e.target.value)} placeholder={'Milk\nBread\nEggs'}
          />
        </Field>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn puffy wide" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </Sheet>
  );
}
