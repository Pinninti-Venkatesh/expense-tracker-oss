import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { dayLabel, priceLabel } from '../lib/billing.js';
import { Icon } from '../components/ui.jsx';

/**
 * Once per account, right after the first sign-in: how long it's free, what it
 * costs after, and that nothing is asked for now. Prices come from Razorpay;
 * where payments aren't set up the price line is left out rather than guessed.
 */
export default function TrialIntro({ me, onContinue }) {
  const [plans, setPlans] = useState([]);
  const [busy, setBusy] = useState(false);
  const billing = me?.billing;

  useEffect(() => {
    api.billing().then((b) => setPlans(b.plans || [])).catch(() => setPlans([]));
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  };

  const prices = ['monthly', 'yearly'].map((id) => plans.find((p) => p.id === id)).filter(Boolean);

  return (
    <div className="solo">
      <div className="solo-card">
        <span className="solo-ico"><Icon name="star" size={26} /></span>
        <h1>Your first {billing?.trialDaysLeft ?? 14} days are free</h1>
        <p className="muted">Everything works during the trial. No card, no autopay, nothing to cancel.</p>

        <div className="card">
          <div className="perm">
            <i><Icon name="check" size={15} /></i>
            <span><b>Free until {dayLabel(billing?.trialEndsAt)}</b><small>You&apos;ll see how many days are left under You.</small></span>
          </div>
          {prices.length > 0 && (
            <div className="perm">
              <i><Icon name="card" size={15} /></i>
              <span>
                <b>Then {prices.map(priceLabel).join(' or ')}</b>
                <small>Paid with UPI Autopay or a card, through Razorpay. Cancel any time.</small>
              </span>
            </div>
          )}
          <div className="perm">
            <i><Icon name="drive" size={15} /></i>
            <span><b>Your data stays yours</b><small>Every spend is in your own Google Drive, whether you subscribe or not.</small></span>
          </div>
        </div>

        <button type="button" className="btn puffy wide" onClick={start} disabled={busy}>
          {busy ? 'Starting…' : 'Start reading my alerts'}
        </button>
      </div>
    </div>
  );
}
