import { money, cardLabel } from '../lib/format.js';
import { effectiveAmount, owedToYou, refundedTotal, isFullyRefunded, isSettleable } from '../lib/analytics.js';
import { Avatar } from './ui.jsx';

/** One spend in a list. The whole row opens the spend sheet. */
export default function SpendRow({ expense: e, onOpen, settleEnabled = false }) {
  const yours = effectiveAmount(e);
  const owed = owedToYou(e);
  const refunded = refundedTotal(e);

  const sub = owed > 0
    ? `${money(owed)} owed to you`
    : e.needsReview
      ? `${e.category}? Tap to check`
      : e.description || (e.items?.length ? e.items.join(', ') : [e.category, cardLabel(e)].filter(Boolean).join(' · '));

  return (
    <button type="button" className="tx" onClick={() => onOpen(e)}>
      <Avatar name={e.merchant} />
      <span className="tx-main">
        <span className="tx-title">
          <b>{e.merchant}</b>
          {e.split && <span className="badge">{e.split.mode === 'lent' ? 'lent' : 'split'}</span>}
          {refunded > 0 && <span className="badge good">{isFullyRefunded(e) ? 'refunded' : 'part refund'}</span>}
          {e.needsReview && <span className="badge amber">check</span>}
          {e.source === 'statement' && <span className="badge grey">{e.paymentType || 'Bank'}</span>}
          {settleEnabled && isSettleable(e) && e.settled && <span className="badge grey">settled</span>}
        </span>
        <small>{sub}</small>
      </span>
      <span className="amt num">
        {money(yours)}
        {Math.abs(yours - Number(e.amount)) > 0.004 && <s>{money(e.amount)}</s>}
      </span>
    </button>
  );
}
