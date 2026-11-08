const pad = (n) => String(n).padStart(2, '0');
export const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 days' },
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'all', label: 'All' },
];

/** Inclusive [start, end] as YYYY-MM-DD, or null for everything. */
export function rangeFor(periodId, now = new Date()) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (periodId) {
    case 'today':
      return { start: toISODate(startOfDay), end: toISODate(startOfDay) };
    case 'week': {
      const from = new Date(startOfDay);
      from.setDate(from.getDate() - 6); // today inclusive
      return { start: toISODate(from), end: toISODate(startOfDay) };
    }
    case 'month':
      return {
        start: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)),
        end: toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      };
    case 'lastMonth':
      return {
        start: toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        end: toISODate(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    default:
      return null;
  }
}

export function filterExpenses(
  expenses,
  { period = 'month', category = null, bank = null, search = '', scope = 'personal' } = {},
) {
  const range = rangeFor(period);
  const needle = search.trim().toLowerCase();

  return expenses.filter((e) => {
    if (e.isExpense === false) return false;
    // Money moved between your own accounts is not spending, so it is kept out
    // of every total — but it is kept, and has a view of its own, because now
    // and then one of them turns out to be a real payment made from the other
    // account. Mirrors server/upi/statement.js.
    if (scope === 'transfers') return Boolean(e.transfer);
    if (e.transfer) return false;
    if (range && (e.date < range.start || e.date > range.end)) return false;
    if (category && e.category !== category) return false;
    if (bank && e.bank !== bank) return false;
    if (needle) {
      const hay = `${e.merchant} ${e.category} ${e.description || ''} ${(e.items || []).join(' ')}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * What a transaction actually cost you. Mirrors server/splits.js — money you
 * lent out isn't your expense while it's owed or once repaid, but a waived
 * amount is money you're never getting back, so it counts.
 */
export function effectiveAmount(e) {
  const amount = Number(e.amount) || 0;

  const base = !e.split
    ? amount
    : Math.round(
      (Number(e.split.yourShare || 0) + e.split.participants
        .filter((p) => p.status === 'waived')
        .reduce((s, p) => s + (Number(p.owed) || 0), 0)) * 100,
    ) / 100;

  // Mirrors server/splits.js — a refund reduces what the charge cost you,
  // floored at zero so an over-refund never reads as negative spending.
  return Math.max(0, Math.round((base - refundedTotal(e)) * 100) / 100);
}

export const refundedTotal = (e) =>
  Math.round((e.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;

export const isFullyRefunded = (e) =>
  refundedTotal(e) > 0 && refundedTotal(e) >= (Number(e.amount) || 0) - 0.005;

/**
 * Card spends that need "settling" — money moved to a separate account to cover
 * the card. Mirrors server/routes/settle.js. UPI and debit leave the bank
 * directly, so only credit-card charges count.
 */
export const isSettleable = (e) => e.paymentType === 'Credit Card' && e.isExpense !== false;

/** Amount to move for a charge: net cost after splits and refunds. */
export const settleAmount = (e) => Math.max(0, Math.round(effectiveAmount(e) * 100) / 100);

/** Still needs money moved. */
export const needsSettling = (e) => isSettleable(e) && !e.settled && settleAmount(e) > 0.005;

/** Mirrors server/learning/corrections.js so the dialog's count matches what
 *  the server will actually update. */
export const merchantKey = (merchant) =>
  String(merchant || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Merchant-level fields — the only ones safe to apply across transactions. */
export const PROPAGATABLE = ['category', 'merchant', 'isExpense'];

/** Mirrors sameMerchant in server/learning/corrections.js — the count shown in
 *  the dialog must equal what the server will actually update. */
export function sameMerchant(a, b) {
  const x = merchantKey(a);
  const y = merchantKey(b);
  if (!x || !y) return false;
  if (x === y) return true;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 3) return false;

  return long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `);
}

/** The other rows a retro-correction would touch, plus the distinct names among
 *  them — bank descriptors vary, so the user should see what "all" covers. */
export function siblingsOf(expenses, expense) {
  const rows = expenses.filter((e) => e.id !== expense.id && sameMerchant(e.merchant, expense.merchant));
  const variants = [...new Set(rows.map((e) => e.merchant))].filter((m) => m !== expense.merchant);
  return { count: rows.length, variants };
}

export function owedToYou(e) {
  if (!e.split) return 0;
  const sum = e.split.participants
    .filter((p) => p.status === 'pending')
    .reduce((s, p) => s + (Number(p.owed) || 0), 0);
  return Math.round(sum * 100) / 100;
}

const inMonth = (e, year, month) => {
  const d = new Date(`${e.date}T00:00:00`);
  return d.getFullYear() === year && d.getMonth() === month;
};

/**
 * Running total by day-of-month. Index 0 is unused so `curve[5]` reads as
 * "spent by the 5th" without off-by-one juggling at the call site.
 */
export function burnCurve(expenses, year, month) {
  const days = new Date(year, month + 1, 0).getDate();
  const daily = new Array(days + 1).fill(0);

  for (const e of expenses) {
    if (e.isExpense === false || e.transfer || !inMonth(e, year, month)) continue;
    daily[new Date(`${e.date}T00:00:00`).getDate()] += effectiveAmount(e);
  }

  const cumulative = new Array(days + 1).fill(0);
  let run = 0;
  for (let i = 1; i <= days; i++) {
    run += daily[i];
    cumulative[i] = run;
  }
  return cumulative;
}

/**
 * This month against last, compared *at the same day of month* — comparing a
 * half-finished month to a whole one would always look like a fall.
 */
export function monthComparison(expenses, now = new Date()) {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const current = burnCurve(expenses, now.getFullYear(), now.getMonth());
  const previous = burnCurve(expenses, prev.getFullYear(), prev.getMonth());

  const today = Math.min(now.getDate(), current.length - 1);
  const soFar = current[today] || 0;
  const previousAtSameDay = previous[Math.min(today, previous.length - 1)] || 0;
  const previousTotal = previous[previous.length - 1] || 0;

  return {
    current,
    previous,
    today,
    soFar,
    previousAtSameDay,
    previousTotal,
    hasPrevious: previousTotal > 0,
    change: previousAtSameDay > 0 ? (soFar - previousAtSameDay) / previousAtSameDay : null,
    previousLabel: prev.toLocaleDateString(undefined, { month: 'long' }),
  };
}

export function topMerchants(expenses, limit = 6) {
  const map = new Map();
  for (const e of expenses) {
    const amount = effectiveAmount(e);
    if (amount <= 0) continue;
    const name = e.merchant || 'Unknown';
    const row = map.get(name) || { merchant: name, total: 0, count: 0 };
    row.total += amount;
    row.count += 1;
    map.set(name, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

/**
 * Categories that moved most in money terms month-on-month. Ranked by absolute
 * change, not percentage — a category going 40 → 400 is +900% and still
 * irrelevant next to one that rose 30,000.
 */
export function categoryShifts(expenses, now = new Date(), limit = 4) {
  const totalsFor = (year, month) => {
    const out = {};
    for (const e of expenses) {
      if (e.isExpense === false || e.transfer || !inMonth(e, year, month)) continue;
      const amount = effectiveAmount(e);
      if (amount <= 0) continue;
      const cat = e.category || 'General';
      out[cat] = (out[cat] || 0) + amount;
    }
    return out;
  };

  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const current = totalsFor(now.getFullYear(), now.getMonth());
  const previous = totalsFor(prev.getFullYear(), prev.getMonth());

  return [...new Set([...Object.keys(current), ...Object.keys(previous)])]
    .map((category) => {
      const a = current[category] || 0;
      const b = previous[category] || 0;
      return {
        category,
        current: a,
        previous: b,
        delta: a - b,
        change: b > 0 ? (a - b) / b : null,
      };
    })
    // Below 500 either way it's noise, not a shift worth surfacing.
    .filter((r) => r.current >= 500 || r.previous >= 500)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, limit);
}

/** Spend was on a card (credit or debit) rather than straight from a bank account. */
export const isCardSpend = (e) => e.source !== 'statement' && /card/i.test(e.paymentType || '');

/** Spend left a bank account directly: statement rows, UPI and net banking. */
export const isBankSpend = (e) => e.source === 'statement' || ['UPI', 'Net Banking'].includes(e.paymentType);

/**
 * Last month in one card, shown on Home for the first week of a new month:
 * the total against the month before, the biggest category change and the top
 * place. Numbers the app already works out, so it costs nothing to show.
 * Null outside that week or when last month had no spending.
 */
export function monthRecap(expenses, now = new Date()) {
  if (now.getDate() > 7) return null;

  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const before = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const lastOf = (curve) => curve[curve.length - 1] || 0;

  const total = lastOf(burnCurve(expenses, prev.getFullYear(), prev.getMonth()));
  if (total <= 0) return null;
  const previousTotal = lastOf(burnCurve(expenses, before.getFullYear(), before.getMonth()));

  const rows = expenses.filter((e) => {
    if (e.isExpense === false || e.transfer) return false;
    const d = new Date(`${e.date}T00:00:00`);
    return d.getFullYear() === prev.getFullYear() && d.getMonth() === prev.getMonth();
  });

  return {
    label: prev.toLocaleDateString('en-IN', { month: 'long' }),
    previousLabel: before.toLocaleDateString('en-IN', { month: 'long' }),
    total,
    previousTotal,
    change: previousTotal > 0 ? total - previousTotal : null,
    biggestShift: categoryShifts(expenses, new Date(prev.getFullYear(), prev.getMonth(), 15), 1)[0] || null,
    topPlace: topMerchants(rows, 1)[0] || null,
    byCategory: aggregate(rows).byCategory.slice(0, 4),
  };
}

/** Totals for the KPI row, plus the category x card matrix the chart needs. */
export function aggregate(expenses) {
  // Charts and totals report YOUR cost, not the amount that left the account —
  // otherwise a loan you got back looks like spending.
  const total = expenses.reduce((s, e) => s + effectiveAmount(e), 0);
  const outstanding = expenses.reduce((s, e) => s + owedToYou(e), 0);

  const banks = [...new Set(expenses.map((e) => e.bank).filter(Boolean))].sort();

  const catMap = new Map();
  for (const e of expenses) {
    const cat = e.category || 'General';
    if (!catMap.has(cat)) catMap.set(cat, { category: cat, total: 0, byBank: {} });
    const row = catMap.get(cat);
    const amount = effectiveAmount(e);
    if (amount <= 0) continue; // fully lent out — nothing of yours to chart
    row.total += amount;
    const b = e.bank || 'Unknown';
    row.byBank[b] = (row.byBank[b] || 0) + amount;
  }
  const byCategory = [...catMap.values()].sort((a, b) => b.total - a.total);

  const bankMap = new Map();
  for (const e of expenses) {
    const b = e.bank || 'Unknown';
    const amount = effectiveAmount(e);
    if (amount > 0) bankMap.set(b, (bankMap.get(b) || 0) + amount);
  }
  const byBank = [...bankMap.entries()]
    .map(([bank, amount]) => ({ bank, total: amount }))
    .sort((a, b) => b.total - a.total);

  // Distinct days present, so the daily average reflects days you actually
  // spent rather than dividing by an arbitrary calendar span.
  const days = new Set(expenses.map((e) => e.date)).size;

  return {
    total, outstanding, count: expenses.length, banks, byCategory, byBank,
    perDay: days ? total / days : 0, days,
  };
}
