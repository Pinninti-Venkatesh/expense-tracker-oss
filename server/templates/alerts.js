/**
 * Alert templates, learned from the model's own answers.
 *
 * Two alerts from one sender that the model has already read are lined up
 * token by token. What stays the same is the sender's fixed wording; what
 * changes is the data. The changing parts that hold the amount, the merchant
 * and the card are the template's fields.
 *
 * A template is data, not code: fixed words in order, with gaps between them.
 * Matching is a forward search with bounded gaps, so no email can make it hang,
 * and nothing learned from one email is ever executed.
 */
import { tokenize, isVariable, keyOf } from './tokens.js';

const MAX_TOKENS = 1200;
// Fixed words kept before the first field and after the last one.
const ANCHOR = 6;
const MIN_FIXED_WORDS = 6;
// How many tokens each gap may span when matching.
const MAX_GAP = { amount: 4, merchant: 25, last4: 3, wild: 60 };

const lower = (tokens) => tokens.map((x) => x.t.toLowerCase());

/** Index pairs of the longest common run of fixed tokens between two token lists. */
function alignment(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const same = (i, j) => a[i] === b[j] && !isVariable(a[i]);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = same(i, j) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(i, j)) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

const gapText = (tokens, text, from, to) => (from < to ? text.slice(tokens[from].start, tokens[to - 1].end) : '');

const numbersIn = (s) => (String(s).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).map(Number);

/** Which field a changing region holds in both examples, or null, or 'conflict'. */
function fieldOf(a, b, exA, exB) {
  const isAmount = (g, amount) => {
    const nums = numbersIn(g.text);
    return nums.length === 1 && Math.abs(nums[0] - amount) < 0.005 && g.size <= MAX_GAP.amount;
  };
  const isLast4 = (g, last4) => Boolean(last4) && g.size <= MAX_GAP.last4 && new RegExp(`${last4}$`).test(g.text);
  const isMerchant = (g, merchant) => {
    const first = keyOf(merchant).split(' ')[0];
    return first.length >= 2 && keyOf(g.text).includes(first) && g.size <= MAX_GAP.merchant;
  };

  const fields = [
    isAmount(a, exA.amount) && isAmount(b, exB.amount) && 'amount',
    isLast4(a, exA.cardLast4) && isLast4(b, exB.cardLast4) && 'last4',
    isMerchant(a, exA.merchant) && isMerchant(b, exB.merchant) && 'merchant',
  ].filter(Boolean);
  if (fields.length > 1) return 'conflict';
  return fields[0] || null;
}

/**
 * Learns a template from two examples { text, amount, merchant, cardLast4, bank,
 * paymentType } that the model extracted from the same sender. Returns
 * { template, raw: { a, b } } with the raw merchant text from each example, or
 * null when the two can't be proven to share one layout.
 */
export function induceTemplate(exA, exB) {
  if (!exA?.text || !exB?.text) return null;
  // Two alerts for the same merchant would teach its name as fixed wording.
  if (keyOf(exA.merchant) === keyOf(exB.merchant)) return null;
  if (keyOf(exA.bank) !== keyOf(exB.bank) || keyOf(exA.paymentType) !== keyOf(exB.paymentType)) return null;

  const ta = tokenize(exA.text).slice(0, MAX_TOKENS);
  const tb = tokenize(exB.text).slice(0, MAX_TOKENS);
  const pairs = alignment(lower(ta), lower(tb));
  const fixedA = ta.filter((x) => !isVariable(x.t)).length;
  const fixedB = tb.filter((x) => !isVariable(x.t)).length;
  if (pairs.length < Math.min(fixedA, fixedB) * 0.6) return null; // different layouts

  // Fixed runs and changing regions, in order.
  const parts = [];
  let run = [];
  let ai = 0;
  let bi = 0;
  for (const [i, j] of [...pairs, [ta.length, tb.length]]) {
    if (i > ai || j > bi) {
      if (run.length) parts.push({ lit: run });
      run = [];
      parts.push({ gap: { a: { text: gapText(ta, exA.text, ai, i), size: i - ai }, b: { text: gapText(tb, exB.text, bi, j), size: j - bi } } });
    }
    if (i < ta.length) run.push(ta[i].t.toLowerCase());
    ai = i + 1;
    bi = j + 1;
  }
  if (run.length) parts.push({ lit: run });

  const raw = {};
  const found = new Set();
  for (const p of parts) {
    if (!p.gap) continue;
    const field = fieldOf(p.gap.a, p.gap.b, exA, exB);
    if (field === 'conflict' || (field && found.has(field))) return null;
    if (field) {
      found.add(field);
      p.field = field;
      if (field === 'merchant') raw.merchant = { a: p.gap.a.text, b: p.gap.b.text };
    }
  }
  if (!found.has('amount') || !found.has('merchant')) return null;
  // A card that differs between the examples has to be read, not assumed.
  if (!found.has('last4') && exA.cardLast4 !== exB.cardLast4) return null;

  const fieldIndexes = parts.map((p, k) => (p.field ? k : -1)).filter((k) => k >= 0);
  const first = fieldIndexes[0];
  const last = fieldIndexes[fieldIndexes.length - 1];
  if (!parts[first - 1]?.lit || !parts[last + 1]?.lit) return null;

  const kept = parts.slice(first - 1, last + 2);
  const template = kept.map((p, k) => {
    if (p.lit) {
      if (k === 0) return { lit: p.lit.slice(-ANCHOR) };
      if (k === kept.length - 1) return { lit: p.lit.slice(0, ANCHOR) };
      return { lit: p.lit };
    }
    return p.field ? { field: p.field } : { wild: true };
  });

  const fixedWords = template.reduce((n, p) => n + (p.lit ? p.lit.length : 0), 0);
  if (fixedWords < MIN_FIXED_WORDS || template[0].lit.length < 2) return null;

  return {
    template: {
      parts: template,
      constants: {
        bank: exA.bank,
        paymentType: exA.paymentType,
        cardLast4: found.has('last4') ? null : exA.cardLast4 || null,
      },
      state: 'trial',
      agree: 0,
      uses: 0,
      createdAt: new Date().toISOString(),
    },
    raw: { a: raw.merchant.a, b: raw.merchant.b },
  };
}

function findRun(words, run, from, lastStart) {
  const end = Math.min(lastStart, words.length - run.length);
  for (let s = from; s <= end; s++) {
    let ok = true;
    for (let k = 0; k < run.length; k++) {
      if (words[s + k] !== run[k]) { ok = false; break; }
    }
    if (ok) return s;
  }
  return -1;
}

/**
 * Reads an email with a template. Returns { amount, merchantRaw, last4 } or null
 * when the email doesn't follow the template or a field doesn't look right.
 */
export function matchTemplate(template, text) {
  const tokens = tokenize(String(text || '').slice(0, 8000)).slice(0, MAX_TOKENS);
  const words = lower(tokens);
  const values = {};
  let pos = 0;
  let open = null;

  for (let k = 0; k < template.parts.length; k++) {
    const p = template.parts[k];
    if (!p.lit) {
      open = { name: p.field || null, from: pos, max: MAX_GAP[p.field || 'wild'] };
      continue;
    }
    const lastStart = k === 0 ? words.length : open ? pos + open.max : pos;
    const at = findRun(words, p.lit, pos, lastStart);
    if (at === -1) return null;
    if (open) {
      if (at === open.from) return null; // an empty field
      if (open.name) values[open.name] = text.slice(tokens[open.from].start, tokens[at - 1].end);
      open = null;
    }
    pos = at + p.lit.length;
  }

  const nums = numbersIn(values.amount || '');
  if (nums.length !== 1 || !(nums[0] > 0)) return null;

  const merchantRaw = String(values.merchant || '').trim();
  if (!merchantRaw || merchantRaw.length > 80 || !/[a-z]/i.test(merchantRaw)) return null;

  let last4 = null;
  if ('last4' in values) {
    const m = values.last4.match(/(\d{4})\D*$/);
    if (!m) return null;
    last4 = m[1];
  }

  return { amount: Math.round(nums[0] * 100) / 100, merchantRaw, last4 };
}
