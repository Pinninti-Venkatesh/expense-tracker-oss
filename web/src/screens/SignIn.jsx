import { useState } from 'react';
import { Icon } from '../components/ui.jsx';

const INTENT_TITLES = {
  signin: 'Connect your Gmail',
  reconnect: 'Reconnect your Gmail',
  'pin-reset': 'Sign in again to reset your PIN',
};

function Step({ n, children }) {
  return (
    <div className="how-step">
      <span className="how-n" aria-hidden="true">{n}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Sign-in for installs that read Gmail with an app password (MAIL_ACCESS=
 * app-password): no Google Cloud project, so no "Continue with Google". Each
 * person makes an app password in their own Google account and pastes it here.
 * The server checks it by signing in to Gmail with it.
 *
 * Used as the last step of the welcome, first-run and invite screens, and as a
 * page of its own at /signin, for reconnecting or resetting a PIN. `endpoint`
 * and `extra` let the first run and invites send it with their own proof (the
 * setup code, the invite).
 */
export function AppPasswordForm({
  intent = 'signin', endpoint = '/api/login/app-password', extra = {}, submitLabel = 'Connect', askName = intent === 'signin', onError,
}) {
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [name, setName] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Not through api.js: a refusal here is an answer to show, never a reason to redirect.
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...extra, email, appPassword, name, intent }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A problem with an earlier step (the setup code, the Claude key) goes back there.
        if (onError?.(body)) {
          setBusy(false);
          return;
        }
        throw new Error(body.error || 'Something went wrong. Please try again.');
      }
      window.location.href = body.redirect || '/';
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="card">
        <Step n={1}>
          Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Google app passwords</a> and
          sign in. If Google says it isn&apos;t available, turn on{' '}
          <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">2-Step Verification</a> first.
        </Step>
        <Step n={2}>Type a name such as <b>Expenses</b> and tap <b>Create</b>.</Step>
        <Step n={3}>Copy the 16 letters Google shows and paste them below.</Step>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="signin-email">Your Gmail address</label>
        <input
          id="signin-email" className="input" type="email" autoComplete="email" inputMode="email" required
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="signin-app-password">App password</label>
        <div className="pwd">
          <input
            id="signin-app-password" type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} required
            placeholder="xxxx xxxx xxxx xxxx" value={appPassword} onChange={(e) => setAppPassword(e.target.value)}
          />
          <button type="button" className="link" onClick={() => setShown((s) => !s)}>{shown ? 'Hide' : 'Show'}</button>
        </div>
      </div>

      {askName && (
        <div className="field">
          <label className="field-label" htmlFor="signin-name">Your name, as your bank writes it (optional)</label>
          <input
            id="signin-name" className="input" autoComplete="name"
            value={name} onChange={(e) => setName(e.target.value)}
          />
          <span className="field-hint">Lets it tell money moved between your own accounts from spending.</span>
        </div>
      )}

      {error && <p className="error-text" role="alert">{error}</p>}

      <button type="submit" className="btn puffy wide" disabled={busy || !email || !appPassword}>
        {busy ? 'Checking with Gmail…' : submitLabel}
      </button>
    </form>
  );
}

export default function SignIn({ intent }) {
  const title = INTENT_TITLES[intent] || INTENT_TITLES.signin;
  return (
    <div className="solo welcome">
      <div className="solo-card">
        <span className="brand-mark" aria-hidden="true"><Icon name="mail" size={20} /></span>
        <h1>{title}</h1>
        {intent === 'reconnect' && (
          <p className="muted">
            Gmail stopped accepting the app password, usually because it was removed or your Google password changed.
            Make a new one; the app catches up on what it missed.
          </p>
        )}
        <AppPasswordForm intent={intent} />
        <a className="link center" href="/">Back</a>
      </div>
    </div>
  );
}
