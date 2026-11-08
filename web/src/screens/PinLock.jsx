import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../components/ui.jsx';

// Signing in with Google again for a PIN reset returns here with ?pinReset=1.
const resetRequested = () => new URLSearchParams(window.location.search).has('pinReset');
const clearResetParam = () => window.history.replaceState(window.history.state, '', window.location.pathname);

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * The lock screen: a keypad, and nothing about the data behind it. The PIN can
 * be 4 to 12 digits, so unlocking is an explicit ✓ rather than automatic at a
 * fixed length — guessing the length for you would spend failed attempts, and
 * too many of those lock the app for a while.
 */
export default function PinLock({ minLength = 4, maxLength = 12, onUnlocked, appPassword = false }) {
  const [mode] = useState(() => (resetRequested() ? 'reset' : 'enter'));
  const [pin, setPin] = useState('');
  const [first, setFirst] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const press = useCallback((digit) => {
    setError(null);
    setPin((p) => (p.length >= maxLength ? p : p + digit));
  }, [maxLength]);
  const erase = useCallback(() => setPin((p) => p.slice(0, -1)), []);

  const submit = useCallback(async () => {
    if (pin.length < minLength || busy) return;

    if (mode === 'reset' && first === null) {
      setFirst(pin);
      setPin('');
      return;
    }
    if (mode === 'reset' && pin !== first) {
      setError("Those didn't match. Choose your new PIN again.");
      setFirst(null);
      setPin('');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (mode === 'reset') {
        await api.pinReset(pin);
        clearResetParam();
      } else {
        await api.pinVerify(pin);
      }
      await onUnlocked();
    } catch (err) {
      setError(err.message);
      setPin('');
      if (mode === 'reset') setFirst(null);
    } finally {
      setBusy(false);
    }
  }, [pin, minLength, busy, mode, first, onUnlocked]);

  useEffect(() => {
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') erase();
      else if (e.key === 'Enter') submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [press, erase, submit]);

  const title = mode === 'enter' ? 'Enter your PIN' : first === null ? 'Choose a new PIN' : 'Enter it again';
  const dots = Math.max(pin.length, minLength);

  return (
    <div className="solo lock">
      <div className="solo-card">
        <span className="lock-ico"><Icon name="lock" size={24} /></span>
        <h1 className="center">{title}</h1>
        {mode === 'reset' && first === null && (
          <p className="muted small center">You signed in with Google again, so you can choose a new PIN.</p>
        )}

        <div className="pin-dots" aria-label={`${pin.length} digits entered`} role="status">
          {Array.from({ length: dots }, (_, i) => <i key={i} className={i < pin.length ? 'f' : ''} />)}
        </div>

        {error && <p className="error-text center">{error}</p>}

        <div className="keypad">
          {KEYS.map((k) => (
            <button type="button" key={k} onClick={() => press(k)} disabled={busy}>{k}</button>
          ))}
          <button type="button" className="key-ghost" onClick={erase} aria-label="Delete a digit" disabled={busy || !pin}>
            <Icon name="backspace" size={24} />
          </button>
          <button type="button" onClick={() => press('0')} disabled={busy}>0</button>
          <button
            type="button" className="key-go" onClick={submit} disabled={busy || pin.length < minLength}
            aria-label={mode === 'enter' ? 'Unlock' : 'Next'}
          >
            <Icon name="check" size={24} />
          </button>
        </div>

        {mode === 'enter' ? (
          <a className="link center" href="/api/login?intent=pin-reset">{appPassword ? 'Forgot it? Reset by signing in again' : 'Forgot it? Reset by signing in with Google'}</a>
        ) : (
          <a className="link center" href="/api/login?intent=pin-reset">{appPassword ? 'Sign in again' : 'Sign in with Google again'}</a>
        )}
        <p className="muted small center">{minLength}–{maxLength} digits. A second lock on top of your {appPassword ? 'sign-in' : 'Google sign-in'}.</p>
      </div>
    </div>
  );
}
