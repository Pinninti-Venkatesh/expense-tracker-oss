import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { planName } from '../lib/billing.js';
import { Field, Sheet, Toggle } from '../components/ui.jsx';

/**
 * Deleting revokes Google access and removes the server's record. The ledger in
 * the user's own Drive is theirs, so removing it is an extra, explicit choice.
 * On an app-password install the ledger is on the app's computer instead, and
 * the app password can only be removed by its owner, so the sheet says where.
 * A plan that can still charge is cancelled with it, and the sheet says so.
 */
export default function DeleteAccountSheet({ onClose, appPassword = false }) {
  const [typed, setTyped] = useState('');
  const [deleteDriveFile, setDeleteDriveFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [billing, setBilling] = useState(null);

  useEffect(() => {
    api.billing().then(setBilling).catch(() => {});
  }, []);

  const planIsLive = ['authenticated', 'active', 'pending'].includes(billing?.status);

  const submit = async (event) => {
    event.preventDefault();
    if (typed !== 'DELETE' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount({ deleteDriveFile });
      window.location.href = '/';
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Sheet title="Delete account" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {appPassword ? (
          <p className="muted">
            This removes your account and the app password it keeps. It can&apos;t be undone. Then remove the password itself
            in <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Google app passwords</a>.
          </p>
        ) : (
          <p className="muted">This removes your account and the app&apos;s access to your Gmail and Drive. It can&apos;t be undone.</p>
        )}
        {planIsLive && (
          <p className="notice amber">Your {planName(billing.plan).toLowerCase()} plan is cancelled too, so nothing more is charged.</p>
        )}
        <div className="toggle-row">
          <label htmlFor="delete-drive-file">{appPassword ? 'Also delete my ledger from this computer' : 'Also delete my ledger file from Google Drive'}</label>
          <Toggle id="delete-drive-file" checked={deleteDriveFile} onChange={setDeleteDriveFile} label="Also delete the ledger file" />
        </div>
        {!deleteDriveFile && (
          <p className="muted small">
            {appPassword ? 'It stays, and comes back if you sign in again with this email.' : 'The file stays in your Drive, so you keep your history.'}
          </p>
        )}
        <Field label="Type DELETE to confirm" htmlFor="delete-confirm">
          <input id="delete-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value.trim())} />
        </Field>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn soft danger wide" disabled={busy || typed !== 'DELETE'}>
          {busy ? 'Deleting…' : 'Delete my account'}
        </button>
      </form>
    </Sheet>
  );
}
