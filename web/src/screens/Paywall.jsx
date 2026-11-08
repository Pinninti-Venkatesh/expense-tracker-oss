import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PlanPicker from '../components/PlanPicker.jsx';
import { ConfirmButton, Icon } from '../components/ui.jsx';

function copyFor(billing) {
  if (billing?.reason === 'lapsed' && (billing.status === 'halted' || billing.status === 'pending')) {
    return {
      title: "Your renewal didn't go through",
      text: "Razorpay couldn't charge your last renewal. Subscribe again to pick up where you left off.",
    };
  }
  if (billing?.reason === 'lapsed') {
    return { title: 'Your plan has ended', text: 'Subscribe again to pick up where you left off.' };
  }
  return { title: 'Your free trial has ended', text: 'Subscribe to keep your spends coming in.' };
}

/**
 * The only screen once the trial or paid days run out. Everything tracked so far
 * stays reachable as a CSV and in the customer's own Drive, and the account can
 * still be deleted.
 */
export default function Paywall({ me, onPaid, onSignOut }) {
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.billing().then(setBilling).catch((err) => setError(err.message));
  }, []);

  const { title, text } = copyFor(billing || me?.billing);

  const deleteAccount = async () => {
    await api.deleteAccount({ deleteDriveFile: false });
    window.location.href = '/';
  };

  return (
    <div className="solo">
      <div className="solo-card">
        <span className="solo-ico"><Icon name="star" size={26} /></span>
        <h1>{title}</h1>
        <p className="muted">{text}</p>

        <div className="card">
          <div className="perm">
            <i><Icon name="check" size={15} /></i>
            <span><b>Nothing is lost</b><small>Every spend you&apos;ve tracked is in your own Google Drive.</small></span>
          </div>
          <div className="perm">
            <i><Icon name="check" size={15} /></i>
            <span><b>It catches up</b><small>Once you subscribe, it reads the bank alerts it missed, from the start of last month.</small></span>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {billing ? <PlanPicker billing={billing} onDone={onPaid} /> : !error && <span className="loader center" role="status" aria-label="Loading plans" />}

        <div className="setg">
          <a className="setr" href="/api/export.csv">
            <span className="si"><Icon name="download" size={16} /></span>
            <span className="setr-text"><b>Download my spends</b><small>Everything as a CSV file</small></span>
          </a>
          {me?.driveFileUrl && (
            <a className="setr" href={me.driveFileUrl} target="_blank" rel="noreferrer">
              <span className="si"><Icon name="drive" size={16} /></span>
              <span className="setr-text"><b>Open my ledger in Drive</b><small>It&apos;s your file</small></span>
            </a>
          )}
        </div>

        <div className="action-row">
          <button type="button" className="btn soft" onClick={onSignOut}><Icon name="logout" size={17} />Sign out</button>
          <ConfirmButton label="Delete account" confirmLabel="Tap again to delete" onConfirm={deleteAccount} />
        </div>
      </div>
    </div>
  );
}
