import { useState } from 'react';
import { AppPasswordForm } from './SignIn.jsx';

async function check(body) {
  const res = await fetch('/api/setup/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || 'Something went wrong. Please try again.'), { field: out.field });
  return out;
}

/**
 * Moving from another computer: a backup file and its passphrase, plus this
 * install's setup code. Everyone's accounts, spends and saved access come back.
 */
function Restore({ onCancel }) {
  const [code, setCode] = useState('');
  const [file, setFile] = useState(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Setup-Code': code, 'X-Backup-Passphrase': passphrase },
        body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
      setDone(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="stack">
        <h1>Welcome back</h1>
        <p className="muted">
          Restored {done.accounts} {done.accounts === 1 ? 'person' : 'people'} and their spends
          {done.createdAt ? `, as they were on ${new Date(done.createdAt).toLocaleDateString()}` : ''}. It carries on reading
          everyone&apos;s email straight away and catches up on what it missed. Each person signs in here once with their
          Gmail and an app password (a new one is fine).
        </p>
        <a className="btn puffy wide" href="/">Sign in</a>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h1>Restore a backup</h1>
      <p className="muted">Moving from another computer? Bring everything across with the backup file made there.</p>
      <div className="field">
        <label className="field-label" htmlFor="restore-code">This app&apos;s setup code</label>
        <input
          id="restore-code" className="input setup-code" inputMode="numeric" autoComplete="one-time-code"
          placeholder="1234-5678" value={code} onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="restore-file">Backup file</label>
        <input id="restore-file" className="input" type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="restore-passphrase">Its passphrase</label>
        <div className="pwd">
          <input id="restore-passphrase" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </div>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button type="submit" className="btn puffy wide" disabled={busy || !file || !passphrase || code.replace(/\D/g, '').length < 8}>
        {busy ? 'Restoring…' : 'Restore'}
      </button>
      <button type="button" className="link center" onClick={onCancel}>Set it up fresh instead</button>
    </form>
  );
}

/**
 * The first run of an app-password install: the person who started the app
 * proves it with the setup code it printed, enters the Claude key (unless the
 * install already has one) and connects their Gmail. They become the owner and
 * invite everyone else from the app. Or they restore a backup from elsewhere.
 */
export default function Setup({ session }) {
  const product = session?.product || 'Expenses';
  const needsKey = session?.setup?.needsKey !== false;
  const steps = needsKey ? ['Setup code', 'Claude', 'Your Gmail'] : ['Setup code', 'Your Gmail'];
  const [step, setStep] = useState(0);
  const [code, setCode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const current = steps[step];

  if (restoring) {
    return (
      <div className="solo welcome">
        <div className="solo-card"><Restore onCancel={() => setRestoring(false)} /></div>
      </div>
    );
  }

  const next = async (event, body) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await check(body);
      setStep(step + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // A refusal at the last step that is about an earlier one sends you back to it.
  const backTo = (body) => {
    const to = body.field === 'code' ? 0 : body.field === 'apiKey' ? 1 : -1;
    if (to < 0) return false;
    setStep(to);
    setError(body.error);
    return true;
  };

  return (
    <div className="solo welcome">
      <div className="solo-card">
        <div className="steps" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={step + 1} aria-label="Setting up">
          {steps.map((label, i) => (
            <span key={label} className={i < step ? 'done' : i === step ? 'on' : ''}>{label}</span>
          ))}
        </div>

        {current === 'Setup code' && (
          <form className="stack" onSubmit={(e) => next(e, { code })}>
            <span className="brand-mark" aria-hidden="true">₹</span>
            <h1>Set up {product}</h1>
            <p className="muted">
              You&apos;re the first here, so you&apos;ll own this app and invite your household from it. To prove you&apos;re the
              one who started it, enter the setup code it showed when it started.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="setup-code">Setup code</label>
              <input
                id="setup-code" className="input setup-code" inputMode="numeric" autoComplete="one-time-code" autoFocus
                placeholder="1234-5678" value={code} onChange={(e) => setCode(e.target.value)}
              />
              <span className="field-hint">
                In the terminal where you started it, or in your host&apos;s logs: &quot;enter this setup code&quot;.
              </span>
            </div>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button type="submit" className="btn puffy wide" disabled={busy || code.replace(/\D/g, '').length < 8}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
            <button type="button" className="link center" onClick={() => setRestoring(true)}>Moving from another computer? Restore a backup</button>
          </form>
        )}

        {current === 'Claude' && (
          <form className="stack" onSubmit={(e) => next(e, { code, apiKey })}>
            <h1>Connect Claude</h1>
            <p className="muted">
              Claude reads each new kind of bank alert and learns its layout, so after the first weeks most alerts are
              read without it. It runs on your own Anthropic account.
            </p>
            <div className="card">
              <div className="how-step"><span className="how-n" aria-hidden="true">1</span>
                <span>Open <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">the Claude console</a>, sign up or sign in, and add a little credit.</span>
              </div>
              <div className="how-step"><span className="how-n" aria-hidden="true">2</span>
                <span>Tap <b>Create key</b>, name it <b>Expenses</b>, and copy it.</span>
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="setup-key">Claude API key</label>
              <div className="pwd">
                <input
                  id="setup-key" type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder="sk-ant-…"
                  value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                />
                <button type="button" className="link" onClick={() => setShown((s) => !s)}>{shown ? 'Hide' : 'Show'}</button>
              </div>
              <span className="field-hint">
                Reading two months of alerts the first time costs roughly ₹50–100; after that, a few rupees a month.
              </span>
            </div>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button type="submit" className="btn puffy wide" disabled={busy || !apiKey.trim()}>
              {busy ? 'Checking the key with Anthropic…' : 'Continue'}
            </button>
            <button type="button" className="link center" onClick={() => { setStep(step - 1); setError(null); }}>Back</button>
          </form>
        )}

        {current === 'Your Gmail' && (
          <>
            <h1>Connect your Gmail</h1>
            <p className="muted">The last step. It reads your bank alerts from here on, starting with the 1st of last month.</p>
            {error && <p className="error-text" role="alert">{error}</p>}
            <AppPasswordForm
              endpoint="/api/setup/claim" extra={{ code, ...(needsKey && { apiKey }) }} submitLabel="Finish setup" onError={backTo}
            />
            <button type="button" className="link center" onClick={() => { setStep(step - 1); setError(null); }}>Back</button>
          </>
        )}
      </div>
    </div>
  );
}
