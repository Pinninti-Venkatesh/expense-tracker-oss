import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, onPinRequired } from './api.js';
import { useAppData } from './useAppData.js';
import { useStack } from './lib/nav.js';
import { buildPeople } from './lib/people.js';
import { needsSettling, settleAmount } from './lib/analytics.js';
import { money, setMaskAmounts } from './lib/format.js';
import { Avatar, Icon } from './components/ui.jsx';
import Home, { LiveLine } from './screens/Home.jsx';
import Spends, { DEFAULT_SPENDS_FILTERS } from './screens/Spends.jsx';
import People from './screens/People.jsx';
import Person from './screens/Person.jsx';
import Loans from './screens/Loans.jsx';
import LoanDetail from './screens/LoanDetail.jsx';
import You from './screens/You.jsx';
import NotSpending from './screens/NotSpending.jsx';
import Categories from './screens/Categories.jsx';
import Statements from './screens/Statements.jsx';
import FirstSync from './screens/FirstSync.jsx';
import Paused from './screens/Paused.jsx';
import PinLock from './screens/PinLock.jsx';
import Welcome from './screens/Welcome.jsx';
import SignIn from './screens/SignIn.jsx';
import Setup from './screens/Setup.jsx';
import Join from './screens/Join.jsx';
import Household from './screens/Household.jsx';
import TrialIntro from './screens/TrialIntro.jsx';
import InstallTip from './screens/InstallTip.jsx';
import Paywall from './screens/Paywall.jsx';
import Plan from './screens/Plan.jsx';
import PullIndicator from './components/PullIndicator.jsx';
import { usePullToRefresh } from './lib/usePullToRefresh.js';
import { shouldShowInstallTip } from './lib/install.js';
import SpendSheet from './sheets/SpendSheet.jsx';
import AddSheet from './sheets/AddSheet.jsx';
import SplitSheet from './sheets/SplitSheet.jsx';
import RefundSheet from './sheets/RefundSheet.jsx';
import FixSheet from './sheets/FixSheet.jsx';
import DetailsSheet from './sheets/DetailsSheet.jsx';
import EntrySheet from './sheets/EntrySheet.jsx';
import RemindSheet from './sheets/RemindSheet.jsx';
import PinSheet from './sheets/PinSheet.jsx';
import DeleteAccountSheet from './sheets/DeleteAccountSheet.jsx';
import LoanSheet from './sheets/LoanSheet.jsx';

// Locking the moment the app goes to the background would fire on every glance
// at a notification. A minute away is the line between "still using it" and
// "put the phone down", which is when someone else picks it up.
const BACKGROUND_LOCK_MS = 60_000;

const MASK_KEY = 'et.maskAmounts';
const SKIP_FIRST_SYNC_KEY = 'et.firstSyncSkipped';

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'spends', label: 'Spends', icon: 'list' },
  { id: 'loans', label: 'Loans', icon: 'loan' },
  { id: 'people', label: 'People', icon: 'people' },
];

const readMask = () => {
  try {
    return localStorage.getItem(MASK_KEY) === '1';
  } catch {
    return false;
  }
};

// The check on opening the app runs when email was last checked longer ago than this.
const STALE_SYNC_MS = 5 * 60 * 1000;
// Batches one "Check now" reads at most, catching up after a long time away.
const MAX_SYNC_ROUNDS = 25;

function findEntry(ledger, id) {
  for (const group of [ledger?.owedToMe, ledger?.iOwe]) {
    for (const person of group?.people || []) {
      const hit = [...(person.entries || []), ...(person.settled || [])].find((e) => e.id === id);
      if (hit) return hit;
    }
  }
  return null;
}

function Nav({ tab, onTab, onAdd, me, syncing, onSync, onOpenYou, onOpenNotSpending, inView }) {
  const item = (t) => (
    <button
      key={t.id} type="button" className={`nav-item${tab === t.id && !inView ? ' on' : ''}`}
      onClick={() => onTab(t.id)} aria-current={tab === t.id && !inView ? 'page' : undefined}
    >
      <Icon name={t.icon} size={22} />
      <span>{t.label}</span>
    </button>
  );

  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-brand wide-only"><span className="brand-ico">₹</span><b>Expenses</b></div>
      {item(TABS[0])}
      {item(TABS[1])}
      <button type="button" className="nav-plus" onClick={() => onAdd()} aria-label="Add">
        <Icon name="plus" size={22} />
        <span className="wide-only">Add</span>
      </button>
      {item(TABS[2])}
      {item(TABS[3])}
      <button type="button" className="nav-item wide-only" onClick={onOpenNotSpending}>
        <Icon name="swap" size={22} /><span>Not spending</span>
      </button>
      <div className="nav-foot wide-only">
        <LiveLine me={me} syncing={syncing} onSync={onSync} className="on-glass" />
        <button type="button" className="nav-me" onClick={onOpenYou}>
          <Avatar name={me?.name || me?.email || 'You'} round size={30} />
          <span>{me?.email}</span>
        </button>
      </div>
    </nav>
  );
}

export default function App() {
  const {
    status, error, session, expenses, categories, ledger, loans, me, pinStatus,
    loadAll, refresh, lock, loadPinStatus, handleError,
  } = useAppData();
  const { stack, push, pop, reset } = useStack();

  const [tab, setTab] = useState('home');
  const [spendsFilters, setSpendsFilters] = useState(DEFAULT_SPENDS_FILTERS);
  const [masked, setMasked] = useState(readMask);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [answeringId, setAnsweringId] = useState(null);
  const [settlingAll, setSettlingAll] = useState(false);
  const [transferBusyId, setTransferBusyId] = useState(null);
  const [skipFirstSync, setSkipFirstSync] = useState(() => {
    try {
      return sessionStorage.getItem(SKIP_FIRST_SYNC_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [installTip, setInstallTip] = useState(shouldShowInstallTip);

  // Onboarding, in order: the trial intro (once per account), the first sync,
  // then the home-screen tip (once per phone).
  const needsTrialIntro = status === 'ready' && me?.billing?.reason === 'trial' && !me?.trialIntroAt;
  const needsFirstSync = status === 'ready' && Boolean(me && !me.firstSyncAt && !skipFirstSync);
  const showInstallTip = status === 'ready' && installTip && !needsTrialIntro && !needsFirstSync;
  const inApp = status === 'ready' && !needsTrialIntro && !needsFirstSync && !showInstallTip;

  // Set during render, before any child formats a number (see lib/format.js).
  setMaskAmounts(masked);

  const notify = useCallback((message, tone = 'info') => {
    const id = Date.now();
    setToast({ id, message, tone });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), tone === 'info' ? 4500 : 8000);
  }, []);

  /** Errors from a tap: lock and pause states take over; anything else is a toast. */
  const report = useCallback((err) => {
    if (err?.name === 'PinRequiredError') return;
    if (err?.name === 'AuthRequiredError') {
      handleError(err);
      return;
    }
    notify(err?.message || 'Something went wrong', 'error');
  }, [handleError, notify]);

  useEffect(() => { onPinRequired(lock); }, [lock]);

  // Auto-lock on return. The server's idle window is the real guarantee; this
  // closes the gap where the app is still unlocked because you were elsewhere.
  useEffect(() => {
    if (!pinStatus?.enabled) return undefined;
    let hiddenAt = null;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt && Date.now() - hiddenAt >= BACKGROUND_LOCK_MS) {
        api.pinLock().catch(() => {});
        lock();
      }
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pinStatus?.enabled, lock]);

  const people = useMemo(() => buildPeople({ expenses, ledger }), [expenses, ledger]);
  const peopleNames = useMemo(() => people.map((p) => p.name), [people]);
  const settle = useMemo(() => {
    const rows = expenses.filter(needsSettling);
    return {
      enabled: Boolean(me?.settings?.settleEnabled),
      count: rows.length,
      total: rows.reduce((s, e) => s + settleAmount(e), 0),
    };
  }, [expenses, me]);

  const toggleMask = (next) => {
    try {
      localStorage.setItem(MASK_KEY, next ? '1' : '0');
    } catch {
      // Storage blocked: the setting lasts for this visit only.
    }
    setMasked(next);
  };

  /* ---------- navigation ---------- */

  const openView = (type, extra = {}) => {
    push({ kind: 'view', type, ...extra });
    window.scrollTo({ top: 0 });
  };
  const openSheet = (type, extra = {}) => push({ kind: 'sheet', type, ...extra });

  const goTab = (id) => {
    if (stack.length) reset();
    setTab(id);
    window.scrollTo({ top: 0 });
  };

  const openSpend = (e) => openSheet('spend', { id: e.id });
  const openPerson = (personKey) => openView('person', { personKey });
  const openAdd = (addType = 'spend', presetName = '') => openSheet('add', { addType, presetName });

  /* ---------- actions ---------- */

  // Checks email until caught up: a server that was off (a sleeping laptop, a
  // host that scales to zero) reads its backlog in batches. `quiet` is the
  // check on opening the app, which only speaks up when it finds something.
  const syncBusy = useRef(false);
  const onSync = async ({ quiet = false } = {}) => {
    if (syncBusy.current) return;
    syncBusy.current = true;
    setSyncing(true);
    try {
      let added = 0;
      let r = {};
      for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
        r = await api.sync();
        added += r.added || 0;
        if (r.abortedReason || r.error || r.skipped || !r.remaining) break;
        await refresh('expenses');
      }
      if (r.abortedReason || r.error) notify(r.abortedReason || r.error, 'error');
      else if (r.skipped === 'already_running') { if (!quiet) notify('Already checking your email'); }
      else if (added || !quiet) notify(added ? `Found ${added} new spend${added === 1 ? '' : 's'}` : 'No new spends');
      await refresh('expenses', 'me');
    } catch (err) {
      report(err);
    } finally {
      syncBusy.current = false;
      setSyncing(false);
    }
  };

  // Opening the app checks email if nobody has lately, so a host that sleeps
  // between visits still shows today's spends.
  const latest = useRef({});
  latest.current = { me, onSync };
  useEffect(() => {
    if (!inApp) return undefined;
    const checkIfStale = () => {
      const { me: m, onSync: sync } = latest.current;
      if (document.hidden || !m || m.syncing) return;
      const last = Date.parse(m.lastSyncAt || '') || 0;
      if (Date.now() - last > STALE_SYNC_MS) sync({ quiet: true });
    };
    checkIfStale();
    document.addEventListener('visibilitychange', checkIfStale);
    return () => document.removeEventListener('visibilitychange', checkIfStale);
  }, [inApp]);

  // Pull down on any screen: check email, then reload everything else.
  const onPullRefresh = async () => {
    await onSync();
    await refresh('ledger', 'loans');
  };
  const topIsSheet = stack[stack.length - 1]?.kind === 'sheet';
  const { pull, ready: pullReady, refreshing } = usePullToRefresh(onPullRefresh, inApp && !topIsSheet);

  const addCategory = async (name) => {
    const r = await api.addCategory(name);
    await refresh('expenses');
    return r.category;
  };

  const spendActions = {
    setCategory: async (e, category, applyToAll) => {
      const r = await api.setExpenseCategory(e.id, category, applyToAll);
      await refresh('expenses');
      notify(r.alsoUpdated
        ? `${e.merchant} will be ${r.category} from now on. Fixed ${r.alsoUpdated} past spend${r.alsoUpdated === 1 ? '' : 's'} too.`
        : `${e.merchant} will be ${r.category} from now on`);
    },
    addCategory,
    markReviewed: async (e) => {
      await api.markReviewed(e.id);
      await refresh('expenses');
      notify(`Kept as ${e.category}`);
    },
    openSplit: (e) => openSheet('split', { id: e.id }),
    openRefund: (e) => openSheet('refund', { id: e.id }),
    openFix: (e) => openSheet('fix', { id: e.id }),
    openDetails: (e) => openSheet('details', { id: e.id }),
    setTransfer: async (e, transfer) => {
      const r = await api.setTransfer(e.id, transfer);
      await refresh('expenses');
      notify(transfer ? `Moved to Not spending. Future payments to ${r.pattern} go there too.` : `${e.merchant} counts as a spend again`);
    },
    remove: async (e) => {
      try {
        await api.deleteExpense(e.id);
        pop();
        await refresh('expenses');
        notify('Deleted');
      } catch (err) {
        report(err);
      }
    },
    lookup: async (e) => {
      const r = await api.enrichOne(e.id);
      await refresh('expenses');
      notify(r.description ? `Found: ${r.description}` : 'No order details found for this one');
    },
    setSplitStatus: async (e, participantId, status) => {
      await api.setSplitStatus(e.id, participantId, status);
      await refresh('expenses');
      notify(status === 'settled' ? 'Marked as paid back' : status === 'waived' ? 'Let go. It now counts as your spend.' : 'Back to owing you');
    },
    unsplit: async (e) => {
      try {
        await api.unsplitExpense(e.id);
        await refresh('expenses');
        notify('Split removed');
      } catch (err) {
        report(err);
      }
    },
    removeRefund: async (e, refundId) => {
      await api.removeRefund(e.id, refundId);
      await refresh('expenses');
      notify('Refund removed');
    },
    settle: async (e, settled) => {
      await api.settleExpense(e.id, settled);
      await refresh('expenses');
      notify(settled ? 'Settled' : 'Marked as not settled');
    },
  };

  const onAnswer = async (e, category) => {
    setAnsweringId(e.id);
    try {
      await spendActions.setCategory(e, category, true);
    } catch (err) {
      report(err);
    } finally {
      setAnsweringId(null);
    }
  };

  const onLooksRight = async (e) => {
    setAnsweringId(e.id);
    try {
      await spendActions.markReviewed(e);
    } catch (err) {
      report(err);
    } finally {
      setAnsweringId(null);
    }
  };

  const onSettleAll = async () => {
    setSettlingAll(true);
    try {
      const r = await api.settleAll();
      await refresh('expenses');
      notify(r.count ? `Settled ${r.count} spend${r.count === 1 ? '' : 's'} · ${money(r.total)}` : 'Nothing to settle');
    } catch (err) {
      report(err);
    } finally {
      setSettlingAll(false);
    }
  };

  const settleAllWith = async (person) => {
    try {
      for (const item of person.open.filter((i) => i.direction === 'lent')) {
        if (item.kind === 'split') await api.setSplitStatus(item.expense.id, item.participant.id, 'settled');
        else await api.addRepayment(item.entry.id, { amount: item.entry.balance, note: 'Settled in full' });
      }
      await refresh('expenses', 'ledger');
      notify(`${person.name} is all paid up`);
    } catch (err) {
      report(err);
      await refresh('expenses', 'ledger');
    }
  };

  const payBack = async (person) => {
    try {
      for (const item of person.open.filter((i) => i.direction === 'borrowed')) {
        await api.addRepayment(item.entry.id, { amount: item.entry.balance, note: 'Paid back in full' });
      }
      await refresh('ledger');
      notify(`Paid ${person.name} back`);
    } catch (err) {
      report(err);
      await refresh('ledger');
    }
  };

  const onCountAsSpend = async (e) => {
    setTransferBusyId(e.id);
    try {
      await spendActions.setTransfer(e, false);
    } catch (err) {
      report(err);
    } finally {
      setTransferBusyId(null);
    }
  };

  const onSettings = async (patch) => {
    try {
      await api.updateSettings(patch);
      await refresh('me');
    } catch (err) {
      report(err);
    }
  };

  const onLockNow = async () => {
    try {
      await api.pinLock();
    } finally {
      reset();
      lock();
    }
  };

  const onSignOut = async () => {
    try {
      await api.logout();
    } finally {
      window.location.href = '/';
    }
  };

  const deleteLoan = async (loan) => {
    try {
      await api.deleteLoan(loan.id);
      pop();
      await refresh('loans');
      notify(`Removed ${loan.name}`);
    } catch (err) {
      report(err);
    }
  };

  /* ---------- gates ---------- */

  const appPassword = session?.mailAccess === 'app-password';
  // A fresh app-password install: the first-run screen, wherever it's opened.
  if (session?.setup?.needed) return <Setup session={session} />;
  // An invite link, signed in or not.
  const joining = appPassword && /^\/join\/([\w-]+)$/.exec(window.location.pathname);
  if (joining) return <Join token={joining[1]} session={session} />;
  // App-password installs sign in, reconnect and reset a PIN on /signin
  // (the server's /api/login sends people there), signed in or not.
  if (appPassword && window.location.pathname === '/signin') {
    return <SignIn intent={new URLSearchParams(window.location.search).get('intent') || 'signin'} />;
  }
  if (status === 'signedOut') return <Welcome session={session} />;
  if (status === 'locked') {
    return (
      <PinLock
        minLength={pinStatus?.minLength} maxLength={pinStatus?.maxLength}
        onUnlocked={async () => { await loadPinStatus(); await loadAll(); }} appPassword={appPassword}
      />
    );
  }
  if (status === 'paused') return <Paused appPassword={appPassword} />;
  if (status === 'paywall') return <Paywall me={me} onPaid={loadAll} onSignOut={onSignOut} />;
  if (status === 'loading') return <div className="solo"><span className="loader" role="status" aria-label="Loading" /></div>;
  if (status === 'error') {
    return (
      <div className="solo">
        <div className="solo-card">
          <h1>Something went wrong</h1>
          <p className="error-text">{error}</p>
          <button type="button" className="btn puffy wide" onClick={loadAll}>Try again</button>
        </div>
      </div>
    );
  }
  if (needsTrialIntro) {
    return <TrialIntro me={me} onContinue={async () => { await api.trialIntroSeen(); await refresh('me'); }} />;
  }
  if (needsFirstSync) {
    return (
      <FirstSync
        expenses={expenses}
        onReload={() => refresh('expenses')}
        onDone={() => refresh('me', 'expenses')}
        onSkip={() => {
          try {
            sessionStorage.setItem(SKIP_FIRST_SYNC_KEY, '1');
          } catch {
            // The skip lasts until reload.
          }
          setSkipFirstSync(true);
        }}
      />
    );
  }
  if (showInstallTip) return <InstallTip onDone={() => setInstallTip(false)} />;

  /* ---------- screens ---------- */

  const viewIndex = stack.map((i) => i.kind).lastIndexOf('view');
  const view = viewIndex >= 0 ? stack[viewIndex] : null;
  const top = stack[stack.length - 1];
  const sheet = top?.kind === 'sheet' ? top : null;

  const renderTab = () => {
    switch (tab) {
      case 'spends':
        return (
          <Spends
            expenses={expenses} filters={spendsFilters} setFilters={setSpendsFilters} settleEnabled={settle.enabled}
            onOpenSpend={openSpend} onOpenNotSpending={() => openView('notSpending')}
          />
        );
      case 'loans':
        return <Loans data={loans} onOpenLoan={(id) => openView('loan', { id })} onAdd={() => openSheet('loan', { id: null })} />;
      case 'people':
        return <People people={people} onOpenPerson={openPerson} onAdd={(direction) => openAdd(direction)} />;
      default:
        return (
          <Home
            expenses={expenses} me={me} people={people} pinEnabled={Boolean(pinStatus?.enabled)}
            masked={masked} onToggleMask={toggleMask}
            onOpenYou={() => openView('you')} onOpenSpend={openSpend}
            onSeeAll={() => goTab('spends')} onSync={onSync} syncing={syncing}
            onAnswer={onAnswer} onLooksRight={onLooksRight} answeringId={answeringId}
            onSetPin={() => openSheet('pin', { mode: 'set' })}
            onOpenPerson={openPerson} onOpenPeople={() => goTab('people')}
            settle={settle} onSettleAll={onSettleAll} settlingAll={settlingAll}
          />
        );
    }
  };

  const renderView = (v) => {
    switch (v.type) {
      case 'person':
        return (
          <Person
            person={people.find((p) => p.key === v.personKey)} onBack={() => pop()}
            onRemind={(p) => openSheet('remind', { personKey: p.key })}
            onSettleAll={settleAllWith} onPayBack={payBack}
            onOpenSpend={openSpend} onOpenEntry={(id) => openSheet('entry', { id })}
            onAdd={(direction, name) => openAdd(direction, name)}
          />
        );
      case 'loan':
        return (
          <LoanDetail
            loan={loans?.loans?.find((l) => l.id === v.id)} onBack={() => pop()}
            onEdit={(loan) => openSheet('loan', { id: loan.id })} onDelete={deleteLoan}
          />
        );
      case 'you':
        return (
          <You
            me={me} pinStatus={pinStatus} masked={masked} onToggleMask={toggleMask} onBack={() => pop()}
            features={session?.features} household={appPassword}
            onSync={onSync} syncing={syncing} onOpenView={(type) => openView(type)}
            onPin={(mode) => openSheet('pin', { mode })} onLockNow={onLockNow} onSettings={onSettings}
            notSpendingCount={expenses.filter((e) => e.transfer).length}
            builtInCount={14} customCount={Math.max(0, categories.length - 14)}
            onSignOut={onSignOut} onDeleteAccount={() => openSheet('deleteAccount')}
          />
        );
      case 'plan':
        return <Plan onBack={() => pop()} onChanged={() => refresh('me')} notify={notify} />;
      case 'notSpending':
        return <NotSpending expenses={expenses} onBack={() => pop()} onCountAsSpend={onCountAsSpend} busyId={transferBusyId} />;
      case 'categories':
        return (
          <Categories
            categories={categories} expenses={expenses} onBack={() => pop()} notify={notify}
            onAdd={async (name) => { await api.addCategory(name); await refresh('expenses'); notify(`Added ${name}`); }}
            onDelete={async (name, reassignTo) => { await api.deleteCategory(name, reassignTo); await refresh('expenses'); }}
          />
        );
      case 'household':
        return <Household onBack={() => pop()} notify={notify} />;
      case 'statements':
        return (
          <Statements
            me={me} expenses={expenses} ai={session?.ai} onBack={() => pop()}
            onImported={() => refresh('expenses')}
            onToggleTransfer={async (e, transfer) => {
              try {
                await spendActions.setTransfer(e, transfer);
              } catch (err) {
                report(err);
              }
            }}
          />
        );
      default:
        return null;
    }
  };

  const byId = (id) => expenses.find((e) => e.id === id);

  const renderSheet = (s) => {
    const close = () => pop();
    switch (s.type) {
      case 'spend':
        return (
          <SpendSheet
            key={s.key} expense={byId(s.id)} allExpenses={expenses} categories={categories}
            settings={me?.settings} onClose={close} actions={spendActions} notify={notify}
          />
        );
      case 'add':
        return (
          <AddSheet
            key={s.key} initialType={s.addType} presetName={s.presetName} categories={categories}
            peopleNames={peopleNames} onAddCategory={addCategory} onClose={close}
            onAddSpend={async (payload) => { await api.addExpense(payload); pop(); await refresh('expenses'); notify('Added'); }}
            onAddEntry={async (payload) => {
              await api.addLedgerEntry(payload);
              pop();
              await refresh('ledger');
              notify(payload.direction === 'lent'
                ? `${payload.personName} owes you ${money(payload.amount)}`
                : `You owe ${payload.personName} ${money(payload.amount)}`);
            }}
            onAddLoan={async (payload) => { await api.addLoan(payload); pop(); await refresh('loans'); notify('Loan added'); }}
          />
        );
      case 'split':
        return (
          <SplitSheet
            key={s.key} expense={byId(s.id)} peopleNames={peopleNames} onClose={close}
            onSave={async (payload) => {
              const r = await api.splitExpense(s.id, payload);
              pop();
              await refresh('expenses');
              notify(`Split saved. Your share is ${money(r.split.yourShare)}.`);
            }}
            onRemove={async () => {
              try {
                await api.unsplitExpense(s.id);
                pop();
                await refresh('expenses');
                notify('Split removed');
              } catch (err) {
                report(err);
              }
            }}
          />
        );
      case 'refund':
        return (
          <RefundSheet
            key={s.key} expense={byId(s.id)} onClose={close}
            onSave={async (payload) => {
              await api.addRefund(s.id, payload);
              pop();
              await refresh('expenses');
              notify(`Refund of ${money(payload.amount)} recorded`);
            }}
          />
        );
      case 'fix':
        return (
          <FixSheet
            key={s.key} expense={byId(s.id)} categories={categories} allExpenses={expenses}
            onAddCategory={addCategory} onClose={close}
            onSave={async (reason, corrected, applyToAll) => {
              const r = await api.flagExpense(s.id, reason, corrected, applyToAll);
              pop();
              await refresh('expenses');
              notify(r.learning);
            }}
          />
        );
      case 'details':
        return (
          <DetailsSheet
            key={s.key} expense={byId(s.id)} onClose={close}
            onSave={async (payload) => { await api.setDetails(s.id, payload); pop(); await refresh('expenses'); notify('Saved'); }}
          />
        );
      case 'entry':
        return (
          <EntrySheet
            key={s.key} entry={findEntry(ledger, s.id)} peopleNames={peopleNames} onClose={close} notify={notify}
            onRepay={async (entry, payload) => { await api.addRepayment(entry.id, payload); await refresh('ledger'); notify('Repayment recorded'); }}
            onRemoveRepayment={async (entry, repaymentId) => { await api.removeRepayment(entry.id, repaymentId); await refresh('ledger'); notify('Repayment removed'); }}
            onUpdate={async (entry, payload) => { await api.updateLedgerEntry(entry.id, payload); await refresh('ledger'); notify('Saved'); }}
            onDelete={async (entry) => { await api.deleteLedgerEntry(entry.id); pop(); await refresh('ledger'); notify('Deleted'); }}
          />
        );
      case 'remind':
        return <RemindSheet key={s.key} person={people.find((p) => p.key === s.personKey)} onClose={close} notify={notify} />;
      case 'pin':
        return (
          <PinSheet
            key={s.key} mode={s.mode} minLength={pinStatus?.minLength} maxLength={pinStatus?.maxLength}
            idleMinutes={pinStatus?.idleMinutes} onClose={close}
            onDone={async (message) => { pop(); await loadPinStatus(); notify(message); }}
          />
        );
      case 'deleteAccount':
        return <DeleteAccountSheet key={s.key} onClose={close} appPassword={session?.mailAccess === 'app-password'} />;
      case 'loan':
        return (
          <LoanSheet
            key={s.key} loan={s.id ? loans?.loans?.find((l) => l.id === s.id) : null} onClose={close}
            onSave={async (payload) => {
              if (s.id) await api.updateLoan(s.id, payload);
              else await api.addLoan(payload);
              pop();
              await refresh('loans');
              notify(s.id ? 'Loan updated' : 'Loan added');
            }}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="shell">
      <PullIndicator pull={pull} ready={pullReady} refreshing={refreshing} />
      <Nav
        tab={tab} onTab={goTab} onAdd={() => openAdd()} me={me} syncing={syncing} onSync={onSync}
        onOpenYou={() => openView('you')} onOpenNotSpending={() => openView('notSpending')} inView={Boolean(view)}
      />
      <main className="main">
        {view ? renderView(view) : renderTab()}
      </main>
      {sheet && renderSheet(sheet)}
      {toast && <div key={toast.id} className={`toast ${toast.tone}`} role="status">{toast.message}</div>}
    </div>
  );
}
