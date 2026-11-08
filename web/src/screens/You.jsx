import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { dayOfMoment, sinceLabel } from '../lib/format.js';
import { planLine } from '../lib/billing.js';
import { Avatar, Icon, ScreenHead, Toggle } from '../components/ui.jsx';

function Row({ icon, title, sub, children, onClick, href, external }) {
  const inner = (
    <>
      <span className="si"><Icon name={icon} size={16} /></span>
      <span className="setr-text"><b>{title}</b>{sub && <small>{sub}</small>}</span>
      {children}
    </>
  );
  if (href) {
    return (
      <a className="setr" href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
        {inner}
      </a>
    );
  }
  if (onClick) return <button type="button" className="setr" onClick={onClick}>{inner}</button>;
  return <div className="setr">{inner}</div>;
}

const Chevron = ({ label }) => (
  <span className="val">{label}<Icon name="chev" size={14} /></span>
);

/** Statement passwords you asked to remember: which banks, and a way to forget them. */
function SavedPasswords() {
  const [banks, setBanks] = useState(null);
  useEffect(() => {
    api.savedStatementPasswords().then((r) => setBanks(r.banks || [])).catch(() => setBanks([]));
  }, []);
  if (!banks?.length) return null;
  return (
    <Row icon="lock" title="Remembered statement passwords" sub={`${banks.map((b) => b.bank).join(', ')} · new statements are read by themselves`}>
      <button type="button" className="link danger" onClick={async () => { await api.forgetStatementPasswords(); setBanks([]); }}>Forget</button>
    </Row>
  );
}

export default function You({
  me, pinStatus, masked, onToggleMask, onBack, onSync, syncing, onOpenView, onPin, onLockNow,
  onSettings, notSpendingCount, builtInCount, customCount, onSignOut, onDeleteAccount, features = {}, household = false,
}) {
  const busy = syncing || me?.syncing;

  return (
    <div className="page narrow">
      <ScreenHead title="You" onBack={onBack} />

      <section className="me-card">
        <Avatar name={me?.name || me?.email || 'You'} round size={48} />
        <div>
          <b>{me?.name || me?.email}</b>
          <small>
            {me?.name ? me.email : ''}
            {me?.name && me?.createdAt ? ' · ' : ''}
            {me?.createdAt ? `joined ${dayOfMoment(me.createdAt)}` : ''}
          </small>
        </div>
      </section>

      <div className="setg">
        <Row
          icon="mail" title="Gmail connection" onClick={busy ? undefined : onSync}
          sub={busy ? 'Checking your email…' : me?.lastSyncAt ? `Reads bank alerts · updated ${sinceLabel(me.lastSyncAt)}` : 'Reads bank alerts every 10 minutes'}
        >
          <span className="val"><span className="dot" />{busy ? '' : 'Check now'}</span>
        </Row>
        {household && (
          <Row icon="people" title="Household" sub="Who uses this app, and inviting someone" onClick={() => onOpenView('household')}>
            <Chevron />
          </Row>
        )}
        {me?.billing && (
          <Row icon="star" title="Plan" sub={planLine(me.billing)} onClick={() => onOpenView('plan')}>
            <Chevron />
          </Row>
        )}
      </div>

      <p className="setlbl">Privacy</p>
      <div className="setg">
        <Row icon={masked ? 'eyeOff' : 'eye'} title="Hide amounts" sub="Dots instead of figures, on this device">
          <Toggle id="toggle-mask" checked={masked} onChange={onToggleMask} label="Hide amounts" />
        </Row>
        <Row
          icon="lock" title="PIN lock"
          sub={pinStatus?.enabled ? `Locks after ${pinStatus.idleMinutes} min idle` : 'Off. Anyone with your unlocked phone can read this.'}
        >
          <Toggle id="toggle-pin" checked={Boolean(pinStatus?.enabled)} onChange={(on) => onPin(on ? 'set' : 'remove')} label="PIN lock" />
        </Row>
        {pinStatus?.enabled && (
          <>
            <Row icon="lock" title="Change PIN" onClick={() => onPin('change')}><Chevron /></Row>
            <Row icon="shield" title="Lock now" onClick={onLockNow}><Chevron /></Row>
          </>
        )}
      </div>

      <p className="setlbl">Your data</p>
      <div className="setg">
        <Row icon="doc" title="Add UPI spends" sub="From any bank's PDF statements" onClick={() => onOpenView('statements')}>
          <Chevron />
        </Row>
        <SavedPasswords />
        <Row icon="swap" title="Not spending" sub="Moves between your own accounts" onClick={() => onOpenView('notSpending')}>
          <Chevron label={notSpendingCount || ''} />
        </Row>
        <Row
          icon="tag" title="Categories" onClick={() => onOpenView('categories')}
          sub={`${builtInCount} built in${customCount ? `, ${customCount} of yours` : ''}`}
        >
          <Chevron />
        </Row>
        <Row icon="pot" title="Track card settling" sub="For moving each card spend into a separate account">
          <Toggle
            id="toggle-settle" checked={Boolean(me?.settings?.settleEnabled)}
            onChange={(v) => onSettings({ settleEnabled: v })} label="Track card settling"
          />
        </Row>
        {me?.driveFileUrl && (
          <Row icon="drive" title="Open my ledger in Drive" sub="It's your file" href={me.driveFileUrl} external>
            <span className="val"><Icon name="external" size={14} /></span>
          </Row>
        )}
        <Row icon="download" title="Download as CSV" sub="Every spend, for a spreadsheet" href="/api/export.csv">
          <Chevron />
        </Row>
      </div>

      {features.legalPages && (
        <div className="setg">
          <Row icon="shield" title="Privacy policy" href="/privacy" external><Chevron /></Row>
          <Row icon="doc" title="Terms" href="/terms" external><Chevron /></Row>
        </div>
      )}

      <div className="action-row">
        <button type="button" className="btn soft" onClick={onSignOut}><Icon name="logout" size={17} />Sign out</button>
        <button type="button" className="btn soft danger" onClick={onDeleteAccount}>Delete account</button>
      </div>
    </div>
  );
}
