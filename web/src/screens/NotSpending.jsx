import { useMemo } from 'react';
import { filterExpenses } from '../lib/analytics.js';
import { formatDay, money } from '../lib/format.js';
import { groupByDay } from '../lib/group.js';
import { Avatar, Empty, ScreenHead } from '../components/ui.jsx';

/**
 * Money moved between your own accounts. On the record, out of every total, and
 * one tap from counting as a spend again — paying a bill from the other account
 * looks exactly like a transfer, and only you can tell.
 */
export default function NotSpending({ expenses, onBack, onCountAsSpend, busyId }) {
  const rows = useMemo(() => filterExpenses(expenses, { period: 'all', scope: 'transfers' }), [expenses]);
  const groups = useMemo(() => groupByDay(rows), [rows]);
  const total = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  return (
    <div className="page narrow">
      <ScreenHead title="Not spending" onBack={onBack} />
      <p className="lede">Money moved between your own accounts. It&apos;s left out of every total. If one was really a payment, count it back in.</p>

      {rows.length ? (
        <>
          <section className="card">
            <div className="row">
              <span className="muted">{rows.length} move{rows.length === 1 ? '' : 's'}</span>
              <b className="num">{money(total)}</b>
            </div>
          </section>
          {groups.map(([day, list]) => (
            <section key={day} className="day-group">
              <h3 className="day"><span>{formatDay(day)}</span></h3>
              <div className="card tx-list">
                {list.map((e) => (
                  <div key={e.id} className="tx static">
                    <Avatar name={e.merchant} />
                    <span className="tx-main">
                      <span className="tx-title"><b>{e.merchant}</b></span>
                      <small>{e.paymentType || 'Bank'}</small>
                    </span>
                    <span className="amt-col">
                      <span className="amt num">{money(e.amount)}</span>
                      <button type="button" className="btn soft sm" disabled={busyId === e.id} onClick={() => onCountAsSpend(e)}>
                        {busyId === e.id ? 'Moving…' : 'Count as spend'}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      ) : (
        <Empty title="Nothing here yet">
          When a bank statement row is money moving between your own accounts, mark it &quot;Not spending&quot; and it lands here, out of your totals.
        </Empty>
      )}
    </div>
  );
}
