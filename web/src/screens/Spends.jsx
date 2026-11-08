import { useMemo } from 'react';
import {
  aggregate, categoryShifts, effectiveAmount, filterExpenses, isBankSpend, isCardSpend, topMerchants,
} from '../lib/analytics.js';
import { formatDay, money, moneyShort } from '../lib/format.js';
import { groupByDay } from '../lib/group.js';
import Bars from '../components/Bars.jsx';
import SpendRow from '../components/SpendRow.jsx';
import { Chip, Empty, Icon, ScreenHead, Seg } from '../components/ui.jsx';

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 days' },
  { id: 'month', label: 'Month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'all', label: 'All' },
];

export const DEFAULT_SPENDS_FILTERS = { view: 'list', period: 'month', source: 'all', search: '', category: null, bank: null };

const bySource = (rows, source) =>
  source === 'cards' ? rows.filter(isCardSpend) : source === 'bank' ? rows.filter(isBankSpend) : rows;

const sum = (rows) => rows.reduce((s, e) => s + effectiveAmount(e), 0);

export default function Spends({ expenses, filters, setFilters, settleEnabled, onOpenSpend, onOpenNotSpending }) {
  const { view, period, source, search, category, bank } = filters;
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  // Charts summarise the whole period, so picking a bar narrows the list
  // without collapsing the chart to that one bar.
  const periodRows = useMemo(() => filterExpenses(expenses, { period, search }), [expenses, period, search]);
  const narrowed = useMemo(
    () => filterExpenses(expenses, { period, search, category, bank }),
    [expenses, period, search, category, bank],
  );
  const visible = useMemo(() => bySource(narrowed, source), [narrowed, source]);
  const groups = useMemo(() => groupByDay(visible), [visible]);

  const stats = useMemo(() => aggregate(periodRows), [periodRows]);
  const shifts = useMemo(() => categoryShifts(expenses), [expenses]);
  const places = useMemo(() => topMerchants(periodRows, 6), [periodRows]);
  const notSpending = useMemo(() => expenses.filter((e) => e.transfer && e.isExpense !== false).length, [expenses]);

  const now = new Date();
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString('en-IN', { month: 'long' });

  const sources = [
    { id: 'all', label: 'All', sub: moneyShort(sum(narrowed)) },
    { id: 'cards', label: 'Cards', sub: moneyShort(sum(narrowed.filter(isCardSpend))) },
    { id: 'bank', label: 'UPI & bank', sub: moneyShort(sum(narrowed.filter(isBankSpend))) },
  ];

  const filtersActive = Boolean(category || bank || search);

  return (
    <div className="page spends">
      <ScreenHead
        title="Spends"
        right={(
          <Seg
            className="seg-compact" label="View"
            options={[{ id: 'list', label: 'List' }, { id: 'charts', label: 'Charts' }]}
            value={view} onChange={(v) => set({ view: v })}
          />
        )}
      />

      <div className="search">
        <Icon name="search" size={16} />
        <input
          id="spends-search" type="search" value={search} onChange={(e) => set({ search: e.target.value })}
          placeholder="Search a place or an item" aria-label="Search spends"
        />
        {search && (
          <button type="button" className="icon-btn ghost sm" onClick={() => set({ search: '' })} aria-label="Clear search">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      <Seg label="Period" options={PERIODS} value={period} onChange={(p) => set({ period: p })} />

      {(category || bank) && (
        <div className="chipset">
          {category && <Chip on onClick={() => set({ category: null })}>{category} ✕</Chip>}
          {bank && <Chip on onClick={() => set({ bank: null })}>{bank} ✕</Chip>}
        </div>
      )}

      {view === 'list' ? (
        <>
          <Seg label="Paid with" options={sources} value={source} onChange={(s) => set({ source: s })} />

          {groups.length ? (
            <div className="day-groups">
              {groups.map(([day, rows]) => (
                <section key={day} className="day-group">
                  <h3 className="day"><span>{formatDay(day)}</span><span className="num">{money(sum(rows))}</span></h3>
                  <div className="card tx-list">
                    {rows.map((e) => <SpendRow key={e.id} expense={e} onOpen={onOpenSpend} settleEnabled={settleEnabled} />)}
                  </div>
                </section>
              ))}
            </div>
          ) : expenses.length ? (
            <Empty
              title="Nothing matches"
              action={filtersActive || period !== 'all' ? (
                <button type="button" className="btn soft sm" onClick={() => setFilters(() => ({ ...DEFAULT_SPENDS_FILTERS, period: 'all' }))}>
                  Show everything
                </button>
              ) : null}
            >
              Try a longer period or clear the filters.
            </Empty>
          ) : (
            <Empty title="No spends yet">Card alerts from your Gmail show up here within about 10 minutes.</Empty>
          )}

          <button type="button" className="row-link" onClick={onOpenNotSpending}>
            <Icon name="swap" size={18} />
            <span>Not spending</span>
            <span className="muted">{notSpending}</span>
            <Icon name="chev" size={16} />
          </button>
        </>
      ) : (
        <div className="chart-grid">
          <section className="card">
            <div className="card-head"><h2>By category</h2><span className="muted small num">{money(stats.total)}</span></div>
            {stats.byCategory.length ? (
              <Bars
                rows={stats.byCategory.map((c) => ({ id: c.category, label: c.category, value: c.total }))}
                selected={category}
                onPick={(id) => set({ category: id, view: 'list' })}
              />
            ) : <p className="muted small">Nothing spent in this period.</p>}
          </section>

          {shifts.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>This month vs {previousMonth}</h2></div>
              <div className="shifts">
                {shifts.map((s) => (
                  <button type="button" key={s.category} className="shift" onClick={() => set({ category: s.category, period: 'month', view: 'list' })}>
                    <span>{s.category}</span>
                    <span className={`num ${s.delta > 0 ? 'up' : 'down'}`}>{s.delta > 0 ? '▲' : '▼'} {money(Math.abs(s.delta))}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {stats.byBank.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>By card or account</h2></div>
              <Bars
                rows={stats.byBank.map((b) => ({ id: b.bank, label: b.bank, value: b.total }))}
                selected={bank}
                onPick={(id) => set({ bank: id, view: 'list' })}
              />
            </section>
          )}

          {places.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>Top places</h2></div>
              <div className="chipset">
                {places.map((p) => (
                  <Chip key={p.merchant} onClick={() => set({ search: p.merchant, view: 'list' })}>
                    {p.merchant} <b className="num">{moneyShort(p.total)}</b>
                  </Chip>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
