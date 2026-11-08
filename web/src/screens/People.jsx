import { useState } from 'react';
import { money } from '../lib/format.js';
import { peopleTotals, personSummary } from '../lib/people.js';
import { Avatar, Empty, Icon, ScreenHead, Seg } from '../components/ui.jsx';

export default function People({ people, onOpenPerson, onAdd }) {
  const [show, setShow] = useState('everyone');
  const totals = peopleTotals(people);

  const list = people.filter((p) => (show === 'owe' ? p.net >= 0.01 : show === 'owed' ? p.net <= -0.01 : true));
  const open = list.filter((p) => p.open.length || Math.abs(p.net) >= 0.01);
  const settled = list.filter((p) => !p.open.length && Math.abs(p.net) < 0.01);

  return (
    <div className="page">
      <ScreenHead
        title="People"
        right={(
          <button type="button" className="icon-btn" onClick={() => onAdd('lent')} aria-label="Add money lent or borrowed">
            <Icon name="plus" />
          </button>
        )}
      />

      {!people.length ? (
        <Empty
          title="Nobody yet"
          action={(
            <div className="action-row">
              <button type="button" className="btn puffy sm" onClick={() => onAdd('lent')}>+ They owe me</button>
              <button type="button" className="btn soft sm" onClick={() => onAdd('borrowed')}>+ I owe them</button>
            </div>
          )}
        >
          Split a spend with friends, or add money you lent or borrowed. Everyone&apos;s balance shows up here.
        </Empty>
      ) : (
        <>
          <section className="hero split-hero">
            <div>
              <span className="hero-label">Friends owe you</span>
              <div className="big num">{money(totals.owedToYou)}</div>
            </div>
            <div className="align-end">
              <span className="hero-label">You owe</span>
              <div className="mid num owe">{money(totals.youOwe)}</div>
            </div>
          </section>

          <Seg
            label="Show"
            value={show}
            onChange={setShow}
            options={[
              { id: 'everyone', label: 'Everyone' },
              { id: 'owe', label: `Owe you · ${totals.owingCount}` },
              { id: 'owed', label: `You owe · ${totals.owedCount}` },
            ]}
          />

          {open.length > 0 && (
            <div className="card tx-list">
              {open.map((p) => (
                <button type="button" key={p.key} className="tx" onClick={() => onOpenPerson(p.key)}>
                  <Avatar name={p.name} round />
                  <span className="tx-main"><span className="tx-title"><b>{p.name}</b></span><small>{personSummary(p)}</small></span>
                  <span className={`amt num${p.net <= -0.01 ? ' owe' : ''}`}>
                    {Math.abs(p.net) >= 0.01 ? money(Math.abs(p.net)) : 'even'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {settled.length > 0 && (
            <div className="card tx-list">
              {settled.map((p) => (
                <button type="button" key={p.key} className="tx" onClick={() => onOpenPerson(p.key)}>
                  <Avatar name={p.name} round />
                  <span className="tx-main"><span className="tx-title"><b>{p.name}</b></span><small>{personSummary(p)}</small></span>
                  <span className="tag grey">settled</span>
                </button>
              ))}
            </div>
          )}

          {!list.length && <p className="muted small center">Nobody in this list.</p>}
        </>
      )}
    </div>
  );
}
