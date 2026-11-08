import { readLastSeen } from '../useAppData.js';
import { shortDate } from '../lib/format.js';
import { Icon } from '../components/ui.jsx';

/** Gmail access stopped. Say why, say nothing is lost, offer one fix. */
export default function Paused({ appPassword = false }) {
  const seen = readLastSeen();
  const where = appPassword ? 'on this computer' : 'in your Google Drive';

  return (
    <div className="solo">
      <div className="solo-card">
        <span className="solo-ico"><Icon name="refresh" size={26} /></span>
        <h1>Paused</h1>
        <p className="muted">
          {appPassword
            ? 'Gmail stopped accepting the app password. That happens when you change your Google password or remove the app password.'
            : 'Google stopped letting the app read your alerts. That happens when you change your Google password or remove the app\'s access.'}
        </p>

        <div className="card">
          <div className="perm">
            <i><Icon name="check" size={15} /></i>
            <span>
              <b>Nothing is lost</b>
              <small>{seen?.latest ? `Every spend up to ${shortDate(seen.latest)} is safe ${where}.` : `Your ledger is safe ${where}.`}</small>
            </span>
          </div>
          <div className="perm">
            <i><Icon name="check" size={15} /></i>
            <span>
              <b>It catches up</b>
              <small>Reconnect and it re-reads your alerts from the start of last month, skipping what it already has.</small>
            </span>
          </div>
        </div>

        <a className="btn puffy wide" href="/api/login?intent=reconnect">{appPassword ? 'Reconnect Gmail' : 'Reconnect Google'}</a>
        {seen?.driveFileUrl && (
          <a className="btn soft wide" href={seen.driveFileUrl} target="_blank" rel="noreferrer">Open my ledger in Drive</a>
        )}
      </div>
    </div>
  );
}
