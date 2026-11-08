/**
 * Privacy mask.
 *
 * A module-level flag rather than a prop or a context: every amount on screen
 * already goes through these three formatters, so flipping one switch here
 * covers the charts, the tabs, the badges and the list without threading state
 * through two dozen components. App sets it during render, before any child
 * reads it. Nothing is fetched differently — the numbers are still in memory,
 * this only stops them being readable over your shoulder.
 */
let masked = false;

export function setMaskAmounts(value) {
  masked = Boolean(value);
}

export const amountsMasked = () => masked;

// Width roughly matches a real figure, so masking doesn't reflow every card.
const MASK = '••••';
const MASK_SHORT = '•••';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
const inrExact = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Rounded for chart labels and totals; exact where the paise matter. */
export const money = (n) => (masked ? `₹${MASK}` : inr.format(Number(n) || 0));
export const moneyExact = (n) => (masked ? `₹${MASK}` : inrExact.format(Number(n) || 0));

/** Compact axis/segment labels: ₹82.2k rather than ₹82,178. */
export function moneyShort(n) {
  if (masked) return `₹${MASK_SHORT}`;
  const v = Number(n) || 0;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(1)}k`;
  return `₹${Math.round(v)}`;
}

/**
 * Deterministic colour per merchant, so Swiggy is always the same green and the
 * eye can skip the label entirely when scanning. Mid-tone lightness on purpose:
 * one value has to hold white text on both the light and dark surface.
 *
 * These carry no meaning beyond identity, so they aren't held to the CVD
 * contract the chart palette is — the merchant name is always shown alongside.
 */
export function merchantColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 42% 46%)`;
}

/** "Zepto Marketplace" → "ZM", "Swiggy" → "Sw". */
export function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || '?').slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

/** "+34%" / "−12%" / null when there's no baseline to compare against. */
export function percentDelta(change) {
  if (change === null || !Number.isFinite(change)) return null;
  const pct = Math.round(change * 100);
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%`;
}

export function formatDay(iso) {
  const date = new Date(`${iso}T00:00:00`);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const formatTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : null;

/**
 * "Jan 2044" — for dates far from today (loan payoff, milestones) where the
 * weekday is noise and the YEAR is the whole point. formatDay deliberately
 * omits the year, which reads as next January on a 2044 date.
 */
export const formatMonthYear = (iso) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '';

/** Money in text that leaves the app, such as a reminder message. Never masked. */
export const moneyPlain = (n) => inr.format(Number(n) || 0);

/**
 * Soft pastel tile per name, for avatars. Identity only — the name is always
 * shown next to it — and light enough to carry dark initials.
 */
export function pastel(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 80% 90%)`;
}

/** "14 Sep" */
export const shortDate = (iso) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';

/** "3 Oct" for a moment (a full ISO timestamp), in this device's own day. */
export const dayOfMoment = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';

/** "September" */
export const monthName = (date = new Date()) => date.toLocaleDateString('en-IN', { month: 'long' });

/** "just now", "4 min ago", "2 hr ago", or a date once it's older than a day. */
export function sinceLabel(iso, now = Date.now()) {
  if (!iso) return null;
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** Where the money came from, as people name it: "HDFC ··4417", "UPI". */
export function cardLabel(e) {
  if (e.source === 'statement') return e.paymentType || 'Bank';
  const bank = e.bank && e.bank !== 'Unknown' ? e.bank : null;
  const last4 = e.cardLast4 ? `··${e.cardLast4}` : null;
  return [bank, last4].filter(Boolean).join(' ') || e.paymentType || null;
}
