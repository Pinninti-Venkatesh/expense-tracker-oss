import { useState } from 'react';
import { api } from '../api.js';
import { openCheckout } from '../lib/razorpay.js';
import { billingStartsOn, dayLabel, planName, priceLabel, rupees, periodLabel, yearlySaving } from '../lib/billing.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Choose monthly or yearly and subscribe through Razorpay Checkout.
 *
 * After Checkout succeeds the server confirms it with Razorpay. If the charge
 * hasn't landed yet (UPI Autopay can take a moment), it asks again for up to a
 * minute before saying so, rather than showing a paywall to someone who paid.
 *
 * billing: the /billing response. onDone(summary) runs once access is confirmed
 * or the mandate is set up.
 */
export default function PlanPicker({ billing, onDone, cta }) {
  const plans = billing?.plans || [];
  const [choice, setChoice] = useState(() => (plans.some((p) => p.id === billing?.plan) ? billing.plan : plans[0]?.id));
  const [stage, setStage] = useState('idle'); // idle | opening | confirming
  const [error, setError] = useState(null);

  if (!billing?.configured || !plans.length) {
    return <p className="notice amber">Payments aren&apos;t set up yet. Please check back soon.</p>;
  }

  const plan = plans.find((p) => p.id === choice) || plans[0];
  const saving = yearlySaving(plans);
  const startsOn = billingStartsOn(billing);

  const subscribe = async () => {
    setError(null);
    setStage('opening');
    try {
      const order = await api.subscribe(plan.id);
      const response = await openCheckout({ ...order, description: `${planName(plan.id)} plan · ${priceLabel(plan)}` });
      if (!response) return; // closed without paying

      setStage('confirming');
      let summary = await api.verifyPayment(response);
      for (let i = 0; i < 20 && !summary.entitled && summary.status !== 'authenticated'; i++) {
        await sleep(3000);
        summary = await api.billing();
      }
      if (summary.entitled || summary.status === 'authenticated') await onDone(summary);
      else setError("Razorpay hasn't confirmed the payment yet. It usually takes a minute; this screen will update once it does.");
    } catch (err) {
      setError(err.message);
    } finally {
      setStage('idle');
    }
  };

  return (
    <div className="stack">
      <div className="modes" role="radiogroup" aria-label="Plan">
        {plans.map((p) => (
          <button
            key={p.id} type="button" role="radio" aria-checked={p.id === plan.id}
            className={`mode${p.id === plan.id ? ' on' : ''}`} onClick={() => setChoice(p.id)}
          >
            <b>{planName(p.id)}</b>
            <span className="plan-price num">{rupees(p.amount, p.currency)}</span>
            <small>{periodLabel(p)}{p.period === 'yearly' && saving > 0 ? ` · save ${rupees(saving, p.currency)}` : ''}</small>
          </button>
        ))}
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <button type="button" className="btn puffy wide" onClick={subscribe} disabled={stage !== 'idle'}>
        {stage === 'opening' ? 'Opening Razorpay…' : stage === 'confirming' ? 'Confirming your payment…' : cta || `Subscribe · ${priceLabel(plan)}`}
      </button>
      <p className="muted small center">
        {startsOn ? `Billing starts on ${dayLabel(startsOn)}, when your free days end. ` : ''}
        UPI Autopay or a card, through Razorpay. Cancel any time.
      </p>
    </div>
  );
}
