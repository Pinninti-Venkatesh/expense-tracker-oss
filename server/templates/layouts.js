/**
 * Statement layouts, learned from rows the model has already read and verified.
 *
 * A layout is two facts about a bank's statement: how its dates are written and
 * which of the trailing figures on a row is the running balance. With those,
 * every row is read without a model and proven with arithmetic: the previous
 * balance minus a debit (or plus a credit) must equal the balance printed on the
 * row. A statement is only accepted when every single row balances.
 *
 *   trial    after the model reads a statement, a layout that reproduces its
 *            debits exactly is kept on trial
 *   live     after LAYOUT_TRIAL_STATEMENTS statements agree, the layout reads
 *            alone, with the model re-checking one statement in LAYOUT_SPOT_CHECK_EVERY
 *   retired  one disagreement, or a statement that stops balancing
 *
 * Statements without a running balance column can't be proven this way, so they
 * keep going to the model.
 */

export const LAYOUT_TRIAL_STATEMENTS = 2;
export const LAYOUT_SPOT_CHECK_EVERY = 6;

const MIN_ROWS = 4;

const DATE_FORMATS = {
  dmy_slash: /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/,
  dmy_dash: /^(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})\b/,
  dmy_dot: /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/,
  dmy_mon: /^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s,]+(\d{4}|\d{2})\b/,
  ymd: /^(\d{4})-(\d{2})-(\d{2})\b/,
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const round2 = (n) => Math.round(n * 100) / 100;

/** The ISO date a line starts with in this format, or null. */
export function readDate(line, format) {
  const m = DATE_FORMATS[format]?.exec(String(line || '').trim());
  if (!m) return null;
  let [d, mo, y] = [m[1], m[2], m[3]];
  if (format === 'ymd') [y, mo, d] = [m[1], m[2], m[3]];
  if (format === 'dmy_mon') mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const year = String(y).length === 2 ? `20${y}` : String(y);
  const iso = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== Number(d)) return null;
  return iso;
}

const MONEY = /^-?\d[\d,]*\.\d{2}$/;
const MARKER = /^(cr|dr)\.?$/i;

/** Figures at the end of a line (after any Cr/Dr), and the text before them. */
export function trailingMoney(line) {
  const tokens = String(line || '').replace(/(\d\.\d{2})(cr|dr)\b/gi, '$1 $2').trim().split(/\s+/);
  while (tokens.length && MARKER.test(tokens[tokens.length - 1])) tokens.pop();
  const money = [];
  while (tokens.length && MONEY.test(tokens[tokens.length - 1])) money.unshift(Number(tokens.pop().replace(/,/g, '')));
  return { money, rest: tokens.join(' ') };
}

function openingBalance(lines) {
  const i = lines.findIndex((l) => /opening balance|balance brought forward|b\/f balance/i.test(l));
  if (i === -1) return null;
  for (const candidate of [lines[i], lines[i + 1]]) {
    const figures = String(candidate || '').replace(/(\d\.\d{2})(cr|dr)\b/gi, '$1 $2').match(/-?\d[\d,]*\.\d{2}/g);
    if (figures?.length) return Number(figures[figures.length - 1].replace(/,/g, ''));
  }
  return null;
}

/**
 * Learns a layout from verified debits { line, date, amount, balance }. Returns
 * { format, balanceFromEnd } when at least 9 in 10 rows agree on both, else null.
 */
export function learnLayout(lines, verified) {
  const rows = (verified || []).filter((r) => r.balance !== null && r.balance !== undefined);
  if (rows.length < MIN_ROWS) return null;
  const enough = (n) => n >= Math.ceil(rows.length * 0.9);

  const format = Object.keys(DATE_FORMATS).find((f) => enough(rows.filter((r) => readDate(lines[r.line], f) === r.date).length));
  if (!format) return null;

  const counts = new Map();
  let amountsPrinted = 0;
  for (const r of rows) {
    const { money } = trailingMoney(lines[r.line]);
    if (money.some((v) => Math.abs(v - r.amount) < 0.005)) amountsPrinted++;
    const fromEnd = [...money].reverse().findIndex((v) => Math.abs(v - r.balance) < 0.005);
    if (fromEnd !== -1) counts.set(fromEnd, (counts.get(fromEnd) || 0) + 1);
  }
  if (!enough(amountsPrinted)) return null;
  const [balanceFromEnd, hits] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (balanceFromEnd === undefined || !enough(hits)) return null;

  return { format, balanceFromEnd };
}

const NOT_NARRATION = /page \d|statement|opening balance|closing balance|total|brought forward|carried forward/i;

/**
 * Reads a statement with a layout. `ok` is true only when there was an opening
 * balance to start from and every dated row balanced, so nothing was guessed.
 */
export function parseWithLayout(lines, spec) {
  let balance = openingBalance(lines);
  const debits = [];
  let credits = 0;
  let unresolved = 0;
  let rowsSeen = 0;
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    const date = readDate(line, spec.format);
    const { money, rest } = trailingMoney(line);

    if (date && money.length > spec.balanceFromEnd) {
      rowsSeen++;
      const at = money.length - 1 - spec.balanceFromEnd;
      const printed = money[at];
      const amounts = money.filter((v, k) => k !== at && v > 0);
      current = null;

      if (balance === null) {
        unresolved++;
      } else {
        const debit = amounts.find((a) => Math.abs(balance - a - printed) < 0.011);
        const credit = amounts.find((a) => Math.abs(balance + a - printed) < 0.011);
        if (debit !== undefined && credit === undefined) {
          current = {
            line: i, date, amount: round2(debit), balance: round2(printed),
            narration: rest.replace(DATE_FORMATS[spec.format], '').trim(), continued: 0,
          };
          debits.push(current);
        } else if (credit !== undefined && debit === undefined) {
          credits++;
        } else {
          unresolved++;
        }
      }
      balance = printed;
    } else if (current && !date && !money.length && line.trim() && !NOT_NARRATION.test(line) && current.continued < 3) {
      // A narration wrapped onto the next lines belongs to the row above.
      current.narration = `${current.narration} ${line.trim()}`;
      current.continued++;
    } else {
      current = null;
    }
  }

  return {
    ok: rowsSeen > 0 && unresolved === 0,
    debits: debits.map(({ continued, ...row }) => row),
    credits,
    unresolved,
    rowsSeen,
  };
}

/** Same debits, by date and amount, regardless of order. */
export function sameDebits(a, b) {
  const counts = new Map();
  const key = (r) => `${r.date}|${round2(Number(r.amount))}`;
  for (const r of a || []) counts.set(key(r), (counts.get(key(r)) || 0) + 1);
  for (const r of b || []) {
    const k = key(r);
    if (!counts.get(k)) return false;
    counts.set(k, counts.get(k) - 1);
  }
  return [...counts.values()].every((v) => v === 0);
}

export function gradeLayout(layout, agreed) {
  if (agreed) {
    layout.agree += 1;
    if (layout.state === 'trial' && layout.agree >= LAYOUT_TRIAL_STATEMENTS) {
      layout.state = 'live';
      layout.liveAt = new Date().toISOString();
    }
  } else {
    layout.state = 'retired';
    layout.retiredAt = new Date().toISOString();
  }
  return layout.state;
}

/** True when a layout may read this statement without the model. */
export function layoutSkipsModel(layout) {
  return layout?.state === 'live' && (layout.uses + 1) % LAYOUT_SPOT_CHECK_EVERY !== 0;
}
