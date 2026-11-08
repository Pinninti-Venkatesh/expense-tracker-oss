import { useState } from 'react';
import { Icon } from '../components/ui.jsx';
import { AppPasswordForm } from './SignIn.jsx';

function Point({ icon, title, children }) {
  return (
    <div className="perm">
      <i><Icon name={icon} size={15} /></i>
      <span><b>{title}</b><small>{children}</small></span>
    </div>
  );
}

function Step({ n, children }) {
  return (
    <div className="how-step">
      <span className="how-n" aria-hidden="true">{n}</span>
      <span>{children}</span>
    </div>
  );
}

function Intro({ product, trialDays }) {
  return (
    <>
      <span className="brand-mark" aria-hidden="true">₹</span>
      <h1>Every spend, without typing a thing</h1>
      <p className="lede">
        {product} reads the alerts your bank already emails you and keeps one clear ledger: this month against last,
        who owes you, and what&apos;s left on your loans.
      </p>
      <div className="card">
        <Point icon="mail" title="Spends appear on their own">Card and UPI alerts from your bank, checked every few minutes.</Point>
        <Point icon="people" title="Splits and IOUs in one place">One balance per person, however it came about.</Point>
        <Point icon="loan" title="Loans that add up">When you&apos;ll be debt-free, and what closing early saves.</Point>
      </div>
      {trialDays && (
        <div className="glass trial-note">
          <b>Free for {trialDays} days</b>
          <span className="glass-sub">No card needed to start.</span>
        </div>
      )}
    </>
  );
}

function Access({ ai, sharing, appPassword }) {
  return (
    <>
      <h1>What it can see</h1>
      {appPassword ? (
        <>
          <p className="muted">You&apos;ll give it an app password for your Gmail. This is exactly what it does with it.</p>
          <div className="card">
            <Point icon="mail" title="Your Gmail, to find bank emails">
              It searches only for bank alerts and statements, and never sends, changes or deletes any email. An app
              password could do more, so remove it in your Google account whenever you stop using the app.
            </Point>
            <Point icon="drive" title="Your ledger stays on this computer">Kept by the computer running the app, never on anyone else&apos;s server.</Point>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Google will ask you to allow two things. This is exactly what they are for.</p>
          <div className="card">
            <Point icon="mail" title="Gmail, read-only">Finds bank alerts and statements. It can&apos;t send, change or delete any email.</Point>
            <Point icon="drive" title="One file in your Google Drive">Your ledger lives in a file the app creates. It can&apos;t open anything else in your Drive.</Point>
          </div>
        </>
      )}
      <div className="card">
        <Point icon="shield" title="AI reads alert text, and that's all">{ai.label} pulls out the amount and the merchant. {ai.retention}</Point>
        {sharing ? (
          <Point icon="swap" title="Bank formats are shared, never your data">
            When several people&apos;s apps learn the same bank email layout, its wording helps everyone&apos;s app read it.
            Your amounts, merchants, cards and name are never part of it.
          </Point>
        ) : (
          <Point icon="swap" title="It learns your banks' formats">
            Once it has seen a bank&apos;s alert layout a few times, it reads that bank&apos;s alerts without the AI.
          </Point>
        )}
      </div>
    </>
  );
}

function GoogleWarning() {
  return (
    <>
      <h1>Google will show a warning</h1>
      <p className="muted">
        This install signs in through its own Google app, which Google hasn&apos;t reviewed, so you&apos;ll see a warning
        before the permissions. This is what to tap.
      </p>
      <div className="google-mock" aria-hidden="true">
        <b>Google hasn&apos;t verified this app</b>
        <span className="google-mock-link">Advanced</span>
      </div>
      <div className="card">
        <Step n={1}>Tap <b>Advanced</b>.</Step>
        <Step n={2}>Tap the <b>Go to … (unsafe)</b> link underneath.</Step>
        <Step n={3}>Allow both: <b>Gmail</b>, read-only, and the app&apos;s file in <b>Drive</b>.</Step>
      </div>
    </>
  );
}

/**
 * Before sign-in: what the app does, what it can see and, while Google hasn't
 * verified the app, the warning Google is about to show. The last step hands
 * over to Google, or on an app-password install asks for the app password.
 */
export default function Welcome({ session }) {
  const product = session?.product || 'Expenses';
  // Only set when the install runs the paid service (BILLING_ENABLED).
  const trialDays = session?.trialDays || null;
  const features = session?.features || {};
  // The server names its own model provider; this only covers a failed fetch.
  const ai = session?.ai || { label: 'Claude', retention: "It isn't used to train models." };
  const appPassword = session?.mailAccess === 'app-password';
  const steps = session?.googleVerified && !appPassword ? ['Welcome', 'Your data'] : ['Welcome', 'Your data', 'Sign in'];
  const [step, setStep] = useState(0);
  const last = step === steps.length - 1;

  const go = (to) => {
    setStep(Math.max(0, Math.min(to, steps.length - 1)));
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="solo welcome">
      <div className="solo-card">
        <div className="steps" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={step + 1} aria-label="Getting started">
          {steps.map((label, i) => (
            <span key={label} className={i < step ? 'done' : i === step ? 'on' : ''}>{label}</span>
          ))}
        </div>

        {step === 0 && <Intro product={product} trialDays={trialDays} />}
        {step === 1 && <Access ai={ai} sharing={features.sharedTemplates} appPassword={appPassword} />}
        {step === 2 && (appPassword ? (
          <>
            <h1>Sign in with your Gmail</h1>
            <p className="muted">New here? Open the invite link you were sent instead; this is for people who have already joined.</p>
          </>
        ) : <GoogleWarning />)}
        {step === 2 && appPassword && <AppPasswordForm />}

        {last && appPassword ? null : last ? (
          <a className="btn puffy wide" href="/api/login">Continue with Google</a>
        ) : (
          <button type="button" className="btn puffy wide" onClick={() => go(step + 1)}>
            {step === 0 ? 'Get started' : 'Continue'}
          </button>
        )}
        {step > 0 && <button type="button" className="btn soft wide" onClick={() => go(step - 1)}>Back</button>}
        {last && features.legalPages && (
          <p className="muted small center">
            By continuing you agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms</a> and{' '}
            <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
          </p>
        )}
      </div>
    </div>
  );
}
