import { useState } from 'react';
import { money, shortDate } from '../lib/format.js';
import { Avatar, ConfirmButton, Empty, Icon, ScreenHead } from '../components/ui.jsx';

const MODE = { equal: 'split equally', shares: 'split by shares', exact: 'split by amount', lent: 'paid for them' };
const DONE = { settled: 'paid back', waived: 'let go' };

function TimelineItem({ item, settled, onOpenSpend, onOpenEntry }) {
  if (item.kind === 'split') {
    const e = item.expense;
    return (
      <button type="button" className="tl" onClick={() => onOpenSpend(e)}>
        <i className={settled ? 'grey' : ''} />
        <span className="tl-main">
          <b>{e.merchant} · {MODE[e.split.mode] || 'split'}</b>
          <small>{shortDate(item.date)} · of {money(e.amount)}{settled ? ` · ${DONE[item.participant.status] || 'settled'}` : ''}</small>
        </span>
        <span className="amt num">{money(item.amount)}</span>
      </button>
    );
  }

  const en = item.entry;
  const lent = en.direction === 'lent';
  const repaidPct = en.amount > 0 ? Math.min(100, (en.repaid / en.amount) * 100) : 0;

  return (
    <button type="button" className="tl" onClick={() => onOpenEntry(en.id)}>
      <i className={settled ? 'grey' : lent ? '' : 'warn'} />
      <span className="tl-main">
        <b>{en.note || (lent ? 'Lent' : 'Borrowed')}</b>
        <small>{shortDate(en.date)} · {money(en.amount)} {lent ? 'lent' : 'borrowed'}</small>
        {!settled && en.repaid > 0 && (
          <>
            <small className="good-text">{money(en.repaid)} paid back so far</small>
            <span className="meter thin"><i style={{ width: `${repaidPct}%` }} /></span>
          </>
        )}
      </span>
      <span className={`amt num${!lent && !settled ? ' owe' : ''}`}>{money(item.amount)}</span>
    </button>
  );
}

export default function Person({ person, onBack, onRemind, onSettleAll, onPayBack, onOpenSpend, onOpenEntry, onAdd }) {
  const [allSettled, setAllSettled] = useState(false);

  if (!person) {
    return (
      <div className="page">
        <ScreenHead title="Person" onBack={onBack} />
        <Empty title="Nothing left here">Everything with this person was removed.</Empty>
      </div>
    );
  }

  const { net } = person;
  const lentOpen = person.open.some((i) => i.direction === 'lent');
  const borrowedOpen = person.open.some((i) => i.direction === 'borrowed');
  const settledShown = allSettled ? person.settled : person.settled.slice(0, 3);

  return (
    <div className="page">
      <ScreenHead title={person.name} onBack={onBack}>
        <Avatar name={person.name} round size={34} />
      </ScreenHead>

      <section className="hero">
        <span className="hero-label">{net >= 0.01 ? 'Owes you' : net <= -0.01 ? 'You owe' : 'All square'}</span>
        <div className={`big num${net <= -0.01 ? ' owe' : ''}`}>{money(Math.abs(net))}</div>
        {person.owesYou > 0 && person.youOwe > 0 && (
          <span className="muted small">{money(person.owesYou)} owed to you · {money(person.youOwe)} you owe</span>
        )}
      </section>

      {(lentOpen || borrowedOpen) && (
        <div className="action-row">
          {lentOpen && (
            <button type="button" className="btn puffy" onClick={() => onRemind(person)}>
              <Icon name="share" size={17} />Remind
            </button>
          )}
          {lentOpen && (
            <ConfirmButton
              className="btn soft" label="Got paid back"
              confirmLabel={`Tap again: ${money(person.owesYou)} back`}
              onConfirm={() => onSettleAll(person)}
            />
          )}
          {borrowedOpen && (
            <ConfirmButton
              className="btn soft" label="I paid them back"
              confirmLabel={`Tap again: ${money(person.youOwe)} paid`}
              onConfirm={() => onPayBack(person)}
            />
          )}
        </div>
      )}

      {person.open.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Open</h2></div>
          <div className="timeline">
            {person.open.map((item) => (
              <TimelineItem key={item.id} item={item} onOpenSpend={onOpenSpend} onOpenEntry={onOpenEntry} />
            ))}
          </div>
        </section>
      )}

      {person.settled.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Settled · {person.settled.length}</h2>
            {person.settled.length > 3 && (
              <button type="button" className="link" onClick={() => setAllSettled((v) => !v)}>
                {allSettled ? 'Show fewer' : 'Show all'}
              </button>
            )}
          </div>
          <div className="timeline">
            {settledShown.map((item) => (
              <TimelineItem key={item.id} item={item} settled onOpenSpend={onOpenSpend} onOpenEntry={onOpenEntry} />
            ))}
          </div>
        </section>
      )}

      <div className="action-row">
        <button type="button" className="btn soft sm" onClick={() => onAdd('lent', person.name)}>+ They owe me</button>
        <button type="button" className="btn soft sm" onClick={() => onAdd('borrowed', person.name)}>+ I owe them</button>
      </div>
    </div>
  );
}
