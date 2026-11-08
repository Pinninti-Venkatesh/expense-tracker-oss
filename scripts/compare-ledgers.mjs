/**
 * Compares two ledger files email by email: a reference (for example another
 * copy of this app that has run for months) against this app's.
 *
 *   node scripts/compare-ledgers.mjs reference.json candidate.json [--all]
 *
 * Both are the JSON files the apps keep in Google Drive; download them from
 * drive.google.com. Nothing is sent anywhere. Spends are matched on the Gmail
 * message id both apps record, over the window the candidate has read: from the
 * 1st of the month before its first sync, to the newest email it has processed.
 */
import fs from 'node:fs';

const [refPath, candPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showAll = process.argv.includes('--all');
if (!refPath || !candPath) {
  console.error('Usage: node scripts/compare-ledgers.mjs reference.json candidate.json [--all]');
  process.exit(2);
}

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ref = load(refPath);
const cand = load(candPath);

const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const localDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const atOf = (e) => Number(e.at) || Date.parse(e.at || '') || Date.parse(`${e.date}T12:00:00+05:30`) || 0;
const fromEmail = (e) => e.source === 'email' && e.emailId;

// The candidate's window: the 1st of last month relative to its first sync, to
// the newest alert it holds.
const candEmail = (cand.expenses || []).filter(fromEmail);
const firstSync = Date.parse(cand.meta?.firstSyncAt || '') || Math.min(...candEmail.map(atOf));
const fs0 = new Date(firstSync);
const windowStart = localDate(Date.UTC(fs0.getUTCFullYear(), fs0.getUTCMonth() - 1, 1, 12));
const windowEndMs = Math.max(...candEmail.map(atOf));
const inWindow = (e) => {
  const d = e.date || localDate(atOf(e));
  return d >= windowStart && atOf(e) <= windowEndMs + 60 * 1000;
};

const refEmail = (ref.expenses || []).filter(fromEmail).filter(inWindow);
const candById = new Map(candEmail.filter(inWindow).map((e) => [e.emailId, e]));
const refById = new Map(refEmail.map((e) => [e.emailId, e]));
const candProcessed = new Set(cand.processedEmailIds || []);

const matched = [];
const onlyRef = [];
for (const e of refEmail) {
  const c = candById.get(e.emailId);
  if (c) matched.push([e, c]);
  else onlyRef.push(e);
}
const onlyCand = [...candById.values()].filter((c) => !refById.has(c.emailId));

const FIELDS = ['amount', 'currency', 'date', 'cardLast4', 'paymentType', 'merchant', 'category'];
const norm = (f, v) => {
  if (v == null || v === '') return '';
  if (f === 'amount') return Number(v).toFixed(2);
  if (f === 'merchant' || f === 'category' || f === 'paymentType') return String(v).trim().toLowerCase();
  return String(v);
};
const diffs = {};
for (const f of FIELDS) diffs[f] = [];
for (const [r, c] of matched) {
  for (const f of FIELDS) if (norm(f, r[f]) !== norm(f, c[f])) diffs[f].push([r, c]);
}
const transferDiffs = matched.filter(([r, c]) => Boolean(r.transfer) !== Boolean(c.transfer));

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const line = (e) => `${e.date}  ${inr(e.amount).padStart(11)}  ${String(e.merchant || '?').slice(0, 30).padEnd(30)}  ${String(e.category || '').padEnd(13)} ${e.cardLast4 ? `••${e.cardLast4}` : ''}`;
const list = (rows, fmt) => {
  const shown = showAll ? rows : rows.slice(0, 15);
  for (const r of shown) console.log(`    ${fmt(r)}`);
  if (rows.length > shown.length) console.log(`    … and ${rows.length - shown.length} more (--all to list them)`);
};

console.log(`\nWindow: ${windowStart} → ${new Date(windowEndMs).toISOString().slice(0, 16).replace('T', ' ')} UTC (what the candidate has read)\n`);
console.log(`Spends from email in the window`);
console.log(`  reference  ${refEmail.length}`);
console.log(`  candidate  ${candById.size}`);
console.log(`  matched    ${matched.length}  (same Gmail message)\n`);

const total = (rows) => rows.reduce((s, e) => s + Number(e.amount || 0), 0);
console.log(`Totals: reference ${inr(total(refEmail))} · candidate ${inr(total([...candById.values()]))}\n`);

console.log(`Only in the reference: ${onlyRef.length}`);
const seen = onlyRef.filter((e) => candProcessed.has(e.emailId));
const unseen = onlyRef.filter((e) => !candProcessed.has(e.emailId));
if (seen.length) {
  console.log(`  read by the candidate but judged not a spend: ${seen.length}`);
  list(seen, line);
}
if (unseen.length) {
  console.log(`  never read by the candidate (its Gmail search missed them): ${unseen.length}`);
  list(unseen, (e) => `${line(e)}  from ${e.sender || '?'}`);
}

console.log(`\nOnly in the candidate: ${onlyCand.length}`);
list(onlyCand, (e) => `${line(e)}  from ${e.sender || '?'}`);

console.log(`\nDifferences on matched spends`);
for (const f of FIELDS) {
  console.log(`  ${f.padEnd(12)} ${diffs[f].length}`);
  if (diffs[f].length && ['amount', 'currency', 'date', 'cardLast4'].includes(f)) {
    list(diffs[f], ([r, c]) => `${r.date}  ${String(r.merchant).slice(0, 24).padEnd(24)}  reference ${r[f] ?? '—'}  ·  candidate ${c[f] ?? '—'}`);
  }
}
console.log(`  ${'not-spending'.padEnd(12)} ${transferDiffs.length}  (marked as a transfer in one ledger only)`);
if (diffs.category.length) {
  console.log(`\nCategory differences are expected where the reference holds your own corrections.`);
  list(diffs.category, ([r, c]) => `${String(r.merchant).slice(0, 24).padEnd(24)}  reference ${r.category}  ·  candidate ${c.category}${c.needsReview ? ' (flagged for a look)' : ''}`);
}

const exact = onlyRef.length === 0 && onlyCand.length === 0 && ['amount', 'currency', 'date', 'cardLast4'].every((f) => diffs[f].length === 0);
console.log(`\n${exact ? 'PASS' : 'DIFFERENT'}: ${exact ? 'the same spends, amounts, dates and cards' : 'see above'}\n`);
process.exit(exact ? 0 : 1);
