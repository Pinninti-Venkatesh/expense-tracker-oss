import { useState } from 'react';
import { api } from '../api.js';
import { Field, Sheet } from '../components/ui.jsx';

const TITLES = { set: 'Set a PIN', change: 'Change PIN', remove: 'Turn off PIN lock' };

export default function PinSheet({ mode, minLength = 4, maxLength = 12, idleMinutes = 15, onClose, onDone }) {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const digits = (value) => value.replace(/\D/g, '').slice(0, maxLength);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (mode !== 'remove') {
      if (pin.length < minLength) return setError(`Use at least ${minLength} digits.`);
      if (pin !== confirm) return setError("Those two PINs don't match.");
    }
    setBusy(true);
    try {
      if (mode === 'remove') {
        await api.pinRemove(current);
        await onDone('PIN lock turned off');
      } else {
        await api.pinSet(pin, current || undefined);
        await onDone(mode === 'set' ? `PIN set. The app locks after ${idleMinutes} idle minutes.` : 'PIN changed');
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
    return undefined;
  };

  const pinInput = (id, label, value, onChange, autoComplete) => (
    <Field label={label} htmlFor={id}>
      <input
        id={id} className="input pin-field num" type="password" inputMode="numeric" autoComplete={autoComplete}
        value={value} onChange={(e) => onChange(digits(e.target.value))} placeholder={`${minLength}–${maxLength} digits`}
      />
    </Field>
  );

  return (
    <Sheet title={TITLES[mode]} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {mode === 'set' && (
          <p className="muted small">A second lock on top of your Google sign-in. Forget it and you can reset it by signing in with Google again.</p>
        )}
        {mode !== 'set' && pinInput('pin-current', 'Current PIN', current, setCurrent, 'off')}
        {mode !== 'remove' && (
          <>
            {pinInput('pin-new', 'New PIN', pin, setPin, 'new-password')}
            {pinInput('pin-confirm', 'Enter it again', confirm, setConfirm, 'new-password')}
          </>
        )}
        {mode === 'remove' && (
          <p className="muted small">Without a PIN, anyone holding your unlocked phone can open the app. Your Google sign-in lasts weeks on this device.</p>
        )}
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className={`btn wide ${mode === 'remove' ? 'soft danger' : 'puffy'}`} disabled={busy}>
          {busy ? 'Saving…' : mode === 'remove' ? 'Turn off PIN lock' : 'Save PIN'}
        </button>
      </form>
    </Sheet>
  );
}
