import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { money, shortDate } from '../lib/format.js';
import { Avatar, Empty, ScreenHead, Seg } from '../components/ui.jsx';

const WINDOWS = [
  { id: 45, label: '45 days' },
  { id: 120, label: '4 months' },
  { id: 365, label: '1 year' },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Add UPI spends in three steps: find statement emails from any bank, unlock
 * each bank's PDFs with its own password, and review what was added. Passwords
 * are used once, unless you tick "remember": then they're kept, encrypted, for
 * you alone, and new statements are read by themselves.
 */
export default function Statements({ expenses, onBack, onImported, onToggleTransfer, ai }) {
  // The server names its own model provider; this only covers a failed fetch.
  const vendor = ai || { label: 'Claude', retention: "It isn't used to train models." };
  const [step, setStep] = useState('find');
  const [days, setDays] = useState(45);
  const [groups, setGroups] = useState([]);
  const [finding, setFinding] = useState(true);
  const [passwords, setPasswords] = useState({});
  const [shown, setShown] = useState({});
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyRow, setBusyRow] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const windowLabel = WINDOWS.find((w) => w.id === days)?.label;

  useEffect(() => {
    let live = true;
    setFinding(true);
    setError(null);
    api.findStatements(days)
      .then((r) => { if (live) setGroups(r.groups || []); })
      .catch((err) => { if (live) setError(err.message); })
      .finally(() => { if (live) setFinding(false); });
    return () => { live = false; };
  }, [days]);

  const pending = groups.filter((g) => g.statements.some((s) => !s.alreadyRead));
  // Banks whose password you asked to remember need nothing typed.
  const remembered = pending.filter((g) => g.needsPassword && g.saved);
  const locked = pending.filter((g) => g.needsPassword && !g.saved);
  const allRead = groups.length > 0 && pending.length === 0;
  const canImport = allRead || pending.some((g) => !g.needsPassword) || remembered.length > 0 || locked.some((g) => passwords[g.key]);

  const unlock = async (event) => {
    event.preventDefault();
    if (busy || !canImport) return;
    setBusy(true);
    setError(null);
    try {
      const typed = Object.fromEntries(locked.filter((g) => passwords[g.key]).map((g) => [g.key, passwords[g.key]]));
      const r = await api.importStatements({ passwords: typed, lookbackDays: days, force: allRead, remember });
      const wrong = Object.values(r.banks || {}).filter((b) => b.wrongPassword);
      const gotSomething = r.added || r.duplicates || r.matchedAlerts || r.skippedCards;
      if (wrong.length && !gotSomething) {
        setError(`That password didn't open your ${wrong.map((b) => b.bank).join(' and ')} statement. Check it and try again.`);
        return;
      }
      if (r.error && !gotSomething) {
        setError(r.error);
        return;
      }
      setPasswords({});
      setResult(r);
      setStep('review');
      await onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const added = useMemo(() => {
    const ids = new Set(result?.addedIds || []);
    return expenses.filter((e) => ids.has(e.id));
  }, [expenses, result]);

  const toggle = async (e) => {
    setBusyRow(e.id);
    try {
      await onToggleTransfer(e, !e.transfer);
    } finally {
      setBusyRow(null);
    }
  };

  const order = ['find', 'unlock', 'review'];
  const stepClass = (name) => {
    const at = order.indexOf(step);
    const index = order.indexOf(name);
    return index === at ? 'on' : index < at ? 'done' : '';
  };

  const wrongBanks = result ? Object.values(result.banks || {}).filter((b) => b.wrongPassword) : [];

  return (
    <div className="page narrow">
      <ScreenHead title="Add UPI spends" onBack={onBack} />

      <div className="steps" aria-label="Steps">
        <span className={stepClass('find')}>Find</span>
        <span className={stepClass('unlock')}>Unlock</span>
        <span className={stepClass('review')}>Review</span>
      </div>

      {step === 'find' && (
        <>
          <Seg label="Look back" options={WINDOWS} value={days} onChange={setDays} />

          {finding ? (
            <p className="muted">Looking for bank statements in your Gmail…</p>
          ) : groups.length ? (
            groups.map((g) => (
              <section key={g.key} className="card">
                <div className="tx static flat">
                  <Avatar name={g.bank} />
                  <span className="tx-main">
                    <span className="tx-title"><b>{g.bank}</b></span>
                    <small>{plural(g.statements.length, 'statement')}</small>
                  </span>
                  {g.needsPassword
                    ? <span className="tag warn">needs password</span>
                    : <span className="tag grey">{g.statements.every((s) => s.alreadyRead) ? 'added before' : 'no password'}</span>}
                </div>
                <div className="stmt-list">
                  {g.statements.map((s) => (
                    <div key={s.id} className="stmt">
                      <span>{s.subject || s.filename}</span>
                      <small>{shortDate(s.date)}{s.alreadyRead ? ' · added before' : ''}</small>
                    </div>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <Empty title="No bank statements found">
              Nothing in your Gmail from the last {windowLabel} looks like a bank statement with a PDF. Try a longer window.
            </Empty>
          )}

          {error && <p className="error-text">{error}</p>}
          {allRead && <p className="muted small">These were all added before. Reading them again only adds rows that are missing.</p>}

          <button type="button" className="btn puffy wide" disabled={finding || !groups.length} onClick={() => setStep('unlock')}>
            Continue
          </button>
          <p className="muted small center">Any bank that emails PDF statements. Card statements are skipped, since card spends come from your alerts.</p>
        </>
      )}

      {step === 'unlock' && (
        <form className="stack" onSubmit={unlock}>
          {locked.length ? locked.map((g, i) => (
            <div key={g.key} className="field">
              <label className="field-label" htmlFor={`statement-password-${i}`}>{g.bank} statement password</label>
              <div className="pwd">
                <input
                  id={`statement-password-${i}`} type={shown[g.key] ? 'text' : 'password'} autoComplete="off" autoFocus={i === 0}
                  value={passwords[g.key] || ''}
                  onChange={(e) => setPasswords((p) => ({ ...p, [g.key]: e.target.value }))}
                />
                <button type="button" className="link" onClick={() => setShown((s) => ({ ...s, [g.key]: !s[g.key] }))}>
                  {shown[g.key] ? 'Hide' : 'Show'}
                </button>
              </div>
              {g.hint && <span className="field-hint">From the email: “{g.hint}”</span>}
            </div>
          )) : (
            <p className="muted">
              {allRead ? 'Nothing new to unlock. These statements will be read again for missing rows.' : 'These statements open without a password.'}
            </p>
          )}

          {remembered.length > 0 && (
            <p className="muted small">
              {remembered.map((g) => g.bank).join(', ')}: password remembered, nothing to type.
            </p>
          )}
          {locked.length > 1 && <p className="muted small">Leave a bank blank to skip it this time.</p>}

          {locked.length > 0 && (
            <label className="check-row" htmlFor="remember-passwords">
              <input id="remember-passwords" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember, and read new statements by themselves</span>
            </label>
          )}

          <div className="glass">
            <b>{remember ? 'Kept for you alone, encrypted' : 'Used once, never saved'}</b>
            <span className="glass-sub">
              {remember
                ? 'Kept on the computer running this app, encrypted, and used only to open your own statements. Nobody else in your household can use it. Forget it any time from You.'
                : 'Each password opens its bank\'s PDFs and is forgotten.'}
              {' '}When the app doesn&apos;t already know a bank&apos;s layout, the statement&apos;s transaction table is read
              by {vendor.label}. {vendor.retention}
            </span>
          </div>

          {error && <p className="error-text">{error}</p>}

          <button type="submit" className="btn puffy wide" disabled={busy || !canImport}>
            {busy ? 'Reading your statements…' : 'Unlock and add'}
          </button>
          <button type="button" className="link center" onClick={() => { setStep('find'); setError(null); }}>Back</button>
        </form>
      )}

      {step === 'review' && result && (
        <>
          <section className="card">
            <dl className="kv">
              <div><dt>Added</dt><dd className="num">{result.added}</dd></div>
              <div><dt>Already recorded</dt><dd className="num">{result.duplicates + result.matchedAlerts}</dd></div>
              <div><dt>Not spending</dt><dd className="num">{result.ignored}</dd></div>
              <div><dt>Card statements skipped</dt><dd className="num">{result.skippedCards}</dd></div>
            </dl>
            {result.matchedAlerts > 0 && (
              <p className="muted small">{plural(result.matchedAlerts, 'spend')} were already in from your bank&apos;s alert emails, so they weren&apos;t added twice.</p>
            )}
            {result.unverified > 0 && (
              <p className="muted small">{plural(result.unverified, 'row')} couldn&apos;t be matched to an amount printed on the statement, so they were left out.</p>
            )}
            {result.unreadable > 0 && (
              <p className="muted small">{plural(result.unreadable, 'statement')} were scanned images with no text the app can read.</p>
            )}
            {result.unparsed > 0 && (
              <p className="muted small">{plural(result.unparsed, 'statement')} had no spending the app could find.</p>
            )}
            {wrongBanks.map((b) => (
              <p key={b.bank} className="error-text">Your {b.bank} statement didn&apos;t open, so it was skipped. Try again with its password.</p>
            ))}
          </section>

          {added.length > 0 && (
            <div className="card tx-list">
              <span className="lbl">Mark any that are money moving between your own accounts</span>
              {added.map((e) => (
                <div key={e.id} className="tx static">
                  <Avatar name={e.merchant} />
                  <span className="tx-main">
                    <span className="tx-title"><b>{e.merchant}</b></span>
                    <small>{e.bank} · {e.paymentType} · {shortDate(e.date)}</small>
                  </span>
                  <span className="amt-col">
                    <span className="amt num">{money(e.amount)}</span>
                    <button type="button" className={`btn sm soft${e.transfer ? ' on' : ''}`} disabled={busyRow === e.id} onClick={() => toggle(e)}>
                      {e.transfer ? 'Not spending ✓' : 'Not spending'}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <button type="button" className="btn puffy wide" onClick={onBack}>Done</button>
        </>
      )}
    </div>
  );
}
