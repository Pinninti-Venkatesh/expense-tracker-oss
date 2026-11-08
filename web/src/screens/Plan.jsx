import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import PlanPicker from '../components/PlanPicker.jsx';
import { ConfirmButton, ScreenHead } from '../components/ui.jsx';
import { dayLabel, planName, priceLabel } from '../lib/billing.js';

function Status({ billing }) {
  const plan = billing.plans?.find((p) => p.id === billing.plan);
  const price = plan ? ` · ${priceLabel(plan)}` : '';

  if (billing.reason === 'paid' && billing.renews) {
    return (
      <>
        <span className="glass-label">{planName(billing.plan)} plan{price}</span>
        <span className="glass-big">Paid until {dayLabel(billing.paidThrough)}</span>
        <span className="glass-sub">
          {billing.status === 'pending'
            ? "The last renewal didn't go through. Razorpay is retrying; your access continues until then."
            : 'Renews automatically through Razorpay.'}
        </span>
      </>
    );
  }
  if (billing.reason === 'paid') {
    return (
      <>
        <span className="glass-label">{planName(billing.plan)} plan · cancelled</span>
        <span className="glass-big">Yours until {dayLabel(billing.paidThrough)}</span>
        <span className="glass-sub">Nothing more will be charged. Subscribe again any time; it starts when these days end.</span>
      </>
    );
  }
  if (billing.status === 'authenticated') {
    return (
      <>
        <span className="glass-label">{planName(billing.plan)} plan{price}</span>
        <span className="glass-big">Starts {dayLabel(billing.startAt)}</span>
        <span className="glass-sub">Autopay is set up. You keep every free day until then.</span>
      </>
    );
  }
  return (
    <>
      <span className="glass-label">Free trial</span>
      <span className="glass-big">{billing.trialDaysLeft} day{billing.trialDaysLeft === 1 ? '' : 's'} left</span>
      <span className="glass-sub">Ends on {dayLabel(billing.trialEndsAt)}. Subscribe now and billing starts then.</span>
    </>
  );
}

/** The plan, from You: what you have, until when, and the one change you can make. */
export default function Plan({ onBack, onChanged, notify }) {
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.billing().then(setBilling).catch((err) => setError(err.message)), []);
  useEffect(() => { load(); }, [load]);

  const canCancel = billing && ['authenticated', 'active', 'pending'].includes(billing.status);
  const canSubscribe = billing && !canCancel;

  const cancel = async () => {
    try {
      const summary = await api.cancelPlan();
      await load();
      await onChanged();
      notify(summary.paidThrough ? `Cancelled. It's yours until ${dayLabel(summary.paidThrough)}.` : 'Cancelled. Nothing will be charged.');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const subscribed = async () => {
    await load();
    await onChanged();
    notify('Thank you. Your plan is set up.');
  };

  return (
    <div className="page narrow">
      <ScreenHead title="Plan" onBack={onBack} />
      {error && <p className="error-text">{error}</p>}
      {!billing && !error && <span className="loader center" role="status" aria-label="Loading" />}

      {billing && (
        <>
          <section className="glass plan-status"><Status billing={billing} /></section>
          {canSubscribe && <PlanPicker billing={billing} onDone={subscribed} />}
          {canCancel && (
            <div className="stack-sm">
              <ConfirmButton label="Cancel plan" confirmLabel="Tap again to cancel" onConfirm={cancel} />
              <p className="muted small">
                {billing.status === 'authenticated'
                  ? 'Cancelling removes the autopay before anything is charged. Your trial continues.'
                  : 'Days you have paid for are kept. Nothing more is charged.'}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
