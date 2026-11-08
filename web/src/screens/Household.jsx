import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { dayOfMoment } from '../lib/format.js';
import { Avatar, ConfirmButton, Icon, ScreenHead } from '../components/ui.jsx';

/**
 * Who uses this install, and (for its owner) inviting people, removing them and
 * changing the Claude key. Everyone's spends stay their own; this screen only
 * shows who is here.
 */
export default function Household({ onBack, notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [keyError, setKeyError] = useState(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [backupError, setBackupError] = useState(null);

  const load = useCallback(() => api.household().then(setData).catch((err) => setError(err.message)), []);
  useEffect(() => { load(); }, [load]);

  const invite = async () => {
    setBusy(true);
    try {
      const r = await api.createInvite();
      setLink(`${window.location.origin}${r.path}`);
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      notify('Link copied');
    } catch {
      notify('Copy it from the box above', 'error');
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: 'Join me on Expenses', text: 'Track your spends with me. This link works once, for 7 days:', url: link });
    } catch {
      // closed the share sheet
    }
  };

  const saveKey = async (event) => {
    event.preventDefault();
    setBusy(true);
    setKeyError(null);
    try {
      await api.setClaudeKey(newKey.trim());
      setKeyOpen(false);
      setNewKey('');
      notify('Claude key updated');
      await load();
    } catch (err) {
      setKeyError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadBackup = async (event) => {
    event.preventDefault();
    if (passphrase !== again) {
      setBackupError("The two passphrases don't match.");
      return;
    }
    setBusy(true);
    setBackupError(null);
    try {
      // Not through api.js: the answer is a file to save, not JSON.
      const res = await fetch('/api/household/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not make a backup.');
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'expenses-backup.json';
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupOpen(false);
      setPassphrase('');
      setAgain('');
      notify('Backup saved. Keep the passphrase somewhere safe too.');
    } catch (err) {
      setBackupError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="page narrow"><ScreenHead title="Household" onBack={onBack} /><p className="error-text">{error}</p></div>;
  if (!data) return <div className="page narrow"><ScreenHead title="Household" onBack={onBack} /><span className="loader" role="status" aria-label="Loading" /></div>;

  return (
    <div className="page narrow">
      <ScreenHead title="Household" onBack={onBack} sub="Everyone sees only their own spends" />

      <div className="card">
        {data.members.map((m) => (
          <div key={m.id} className="member-row">
            <Avatar name={m.name || m.email} round size={36} />
            <span className="who">
              <b>{m.name || m.email}{m.you ? ' (you)' : ''}</b>
              <small>{m.name ? `${m.email} · ` : ''}{m.owner ? 'set it up' : `joined ${dayOfMoment(m.joinedAt)}`}</small>
            </span>
            {data.isOwner && !m.you && (
              <ConfirmButton
                label="Remove" confirmLabel="Remove?" className="link danger"
                onConfirm={async () => { await api.removeMember(m.id); notify(`${m.name || m.email} removed`); await load(); }}
              />
            )}
          </div>
        ))}
      </div>

      {data.isOwner && (
        <>
          <p className="setlbl">Invite someone</p>
          <div className="stack">
            {link ? (
              <div className="invite-link">
                <code>{link}</code>
                <div className="invite-actions">
                  {typeof navigator.share === 'function' && (
                    <button type="button" className="btn puffy" onClick={share}><Icon name="share" size={16} />Share</button>
                  )}
                  <button type="button" className="btn soft" onClick={copy}><Icon name="copy" size={16} />Copy</button>
                </div>
                <small className="muted">Works once, for 7 days. They&apos;ll connect their own Gmail.</small>
              </div>
            ) : (
              <button type="button" className="btn puffy wide" onClick={invite} disabled={busy}>
                <Icon name="plus" size={16} />Make an invite link
              </button>
            )}
            {data.invites.length > 0 && (
              <p className="muted small">
                {data.invites.length} unused link{data.invites.length === 1 ? '' : 's'}.{' '}
                <button
                  type="button" className="link"
                  onClick={async () => { await Promise.all(data.invites.map((i) => api.cancelInvite(i.id))); setLink(null); await load(); }}
                >
                  Cancel {data.invites.length === 1 ? 'it' : 'them'}
                </button>
              </p>
            )}
          </div>
        </>
      )}

      {data.canBackup && (
        <>
          <p className="setlbl">Backup</p>
          <div className="card stack">
            <p className="muted small" style={{ margin: 0 }}>
              Everyone&apos;s spends live on the computer running this app. A backup is all of it in one file, locked with a
              passphrase you choose. Keep one somewhere else, and use it to move the app to another computer or the cloud.
            </p>
            {backupOpen ? (
              <form className="stack" onSubmit={downloadBackup}>
                <div className="pwd">
                  <input
                    aria-label="Passphrase" type="password" autoComplete="new-password" placeholder="Passphrase (8+ characters)"
                    value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
                  />
                </div>
                <div className="pwd">
                  <input
                    aria-label="Passphrase again" type="password" autoComplete="new-password" placeholder="Same again"
                    value={again} onChange={(e) => setAgain(e.target.value)}
                  />
                </div>
                <span className="field-hint">Without it the backup can&apos;t be opened, by anyone, including you.</span>
                {backupError && <p className="error-text" role="alert">{backupError}</p>}
                <div className="action-row">
                  <button type="submit" className="btn puffy" disabled={busy || passphrase.length < 8 || !again}>
                    {busy ? 'Making it…' : 'Download backup'}
                  </button>
                  <button type="button" className="btn soft" onClick={() => { setBackupOpen(false); setBackupError(null); }}>Cancel</button>
                </div>
              </form>
            ) : (
              <button type="button" className="btn soft wide" onClick={() => setBackupOpen(true)}>
                <Icon name="download" size={16} />Back up everything
              </button>
            )}
          </div>
        </>
      )}

      {data.claude?.provider === 'anthropic' && (
        <>
          <p className="setlbl">Claude</p>
          <div className="card stack">
            <div className="member-row">
              <span className="who">
                <b>API key</b>
                <small>{data.claude.key || 'Not set'} · on the owner&apos;s Anthropic account</small>
              </span>
              {data.claude.changeable && !keyOpen && (
                <button type="button" className="link" onClick={() => setKeyOpen(true)}>Change</button>
              )}
            </div>
            {keyOpen && (
              <form className="stack" onSubmit={saveKey}>
                <div className="pwd">
                  <input
                    aria-label="New Claude API key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…"
                    value={newKey} onChange={(e) => setNewKey(e.target.value)}
                  />
                </div>
                {keyError && <p className="error-text" role="alert">{keyError}</p>}
                <div className="action-row">
                  <button type="submit" className="btn puffy" disabled={busy || !newKey.trim()}>{busy ? 'Checking…' : 'Save'}</button>
                  <button type="button" className="btn soft" onClick={() => { setKeyOpen(false); setKeyError(null); }}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
