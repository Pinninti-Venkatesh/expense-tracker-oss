import { useState } from 'react';
import { reminderText } from '../lib/people.js';
import { copyText, shareText } from '../lib/share.js';
import { Icon, Sheet } from '../components/ui.jsx';

/** A friendly message to send yourself. The app never sends anything. */
export default function RemindSheet({ person, onClose, notify }) {
  const [text, setText] = useState(() => (person ? reminderText(person) : ''));
  const [busy, setBusy] = useState(false);

  if (!person) return null;

  const share = async () => {
    setBusy(true);
    try {
      const outcome = await shareText(text);
      if (outcome === 'copied') notify('Copied. Paste it into a chat.');
      if (outcome === 'shared') onClose();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await copyText(text);
      notify('Copied');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  return (
    <Sheet title={`Remind ${person.name}`} onClose={onClose}>
      <div className="stack">
        <label className="field-label" htmlFor="remind-text">Message</label>
        <textarea id="remind-text" className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="muted small">You choose where it goes. Nothing is sent from the app.</p>
        <div className="action-row">
          <button type="button" className="btn puffy" onClick={share} disabled={busy || !text.trim()}>
            <Icon name="share" size={17} />Share
          </button>
          <button type="button" className="btn soft" onClick={copy} disabled={!text.trim()}>
            <Icon name="copy" size={17} />Copy
          </button>
        </div>
      </div>
    </Sheet>
  );
}
