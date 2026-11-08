import { moneyPlain, shortDate } from './format.js';

/**
 * One balance per person, however it came about.
 *
 * Money between you and a friend arrives two ways: a card spend you split, and
 * money you lent or borrowed by hand. People think in names, not in those two
 * record types, so both are gathered under the person's name here.
 *
 *   owesYou — splits still pending plus what's left on money you lent
 *   youOwe  — what's left on money you borrowed
 *   net     — owesYou minus youOwe; the one number the People tab leads with
 */

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const personKey = (name) => String(name || '').trim().toLowerCase();

const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

export function buildPeople({ expenses = [], ledger = null } = {}) {
  const map = new Map();
  const row = (name) => {
    const key = personKey(name);
    if (!map.has(key)) {
      map.set(key, { key, name: String(name || '').trim(), owesYou: 0, youOwe: 0, open: [], settled: [], lastDate: '' });
    }
    return map.get(key);
  };
  const touch = (r, date) => {
    if (date && date > r.lastDate) r.lastDate = date;
  };

  for (const e of expenses) {
    if (!e.split || e.isExpense === false) continue;
    for (const p of e.split.participants || []) {
      if (!personKey(p.name)) continue;
      const r = row(p.name);
      const item = {
        kind: 'split', id: `${e.id}:${p.id}`, date: e.date, amount: round(p.owed), direction: 'lent', expense: e, participant: p,
      };
      if (p.status === 'pending') {
        r.owesYou += Number(p.owed) || 0;
        r.open.push(item);
      } else {
        r.settled.push(item);
      }
      touch(r, e.date);
    }
  }

  for (const group of [ledger?.owedToMe, ledger?.iOwe]) {
    for (const person of group?.people || []) {
      for (const entry of person.entries || []) {
        const r = row(entry.personName);
        if (entry.direction === 'lent') r.owesYou += Number(entry.balance) || 0;
        else r.youOwe += Number(entry.balance) || 0;
        r.open.push({ kind: 'entry', id: entry.id, date: entry.date, amount: round(entry.balance), direction: entry.direction, entry });
        touch(r, entry.date);
      }
      for (const entry of person.settled || []) {
        const r = row(entry.personName);
        r.settled.push({ kind: 'entry', id: entry.id, date: entry.date, amount: round(entry.amount), direction: entry.direction, entry });
        touch(r, entry.date);
      }
    }
  }

  const isOpen = (p) => Math.abs(p.net) >= 0.01 || p.open.length > 0;

  return [...map.values()]
    .map((r) => {
      const owesYou = round(r.owesYou);
      const youOwe = round(r.youOwe);
      return { ...r, owesYou, youOwe, net: round(owesYou - youOwe), open: r.open.sort(byDateDesc), settled: r.settled.sort(byDateDesc) };
    })
    .sort((a, b) => {
      const ao = isOpen(a);
      const bo = isOpen(b);
      if (ao !== bo) return ao ? -1 : 1;
      if (ao) return Math.abs(b.net) - Math.abs(a.net);
      return a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0;
    });
}

/** Header totals: what friends owe you and what you owe, person by person net. */
export function peopleTotals(people = []) {
  let owedToYou = 0;
  let youOwe = 0;
  let owingCount = 0;
  let owedCount = 0;
  for (const p of people) {
    if (p.net >= 0.01) { owedToYou += p.net; owingCount++; }
    if (p.net <= -0.01) { youOwe += -p.net; owedCount++; }
  }
  return { owedToYou: round(owedToYou), youOwe: round(youOwe), owingCount, owedCount };
}

/** A line under a person's name: what the balance is made of, or when it settled. */
export function personSummary(person) {
  if (!person.open.length) {
    return person.lastDate ? `All settled · ${shortDate(person.lastDate)}` : 'All settled';
  }
  const parts = person.open.slice(0, 2).map((item) => {
    if (item.kind === 'split') return `${item.expense.merchant} split`;
    const what = item.entry.note || (item.direction === 'lent' ? 'lent' : 'borrowed');
    return item.direction === 'borrowed' ? `You owe · ${what}` : what;
  });
  const more = person.open.length - parts.length;
  return `${parts.join(' · ')}${more > 0 ? ` · ${more} more` : ''}`;
}

const listing = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] || '';

/** A friendly reminder to share. Amounts are never masked here: it's for them. */
export function reminderText(person) {
  const first = person.name.split(/\s+/)[0] || person.name;
  const lines = person.open
    .filter((item) => item.direction === 'lent')
    .map((item) => {
      if (item.kind === 'split') return `${moneyPlain(item.amount)} for ${item.expense.merchant}`;
      return item.entry.note
        ? `${moneyPlain(item.amount)} for ${item.entry.note}`
        : `${moneyPlain(item.amount)} from ${shortDate(item.date)}`;
    });

  if (!lines.length) return `Hey ${first}, just checking in on what we owe each other.`;

  const total = person.youOwe > 0
    ? ` ${moneyPlain(person.net)} in all, after what I owe you.`
    : lines.length > 1 ? ` ${moneyPlain(person.owesYou)} in all.` : '';
  return `Hey ${first}, quick one: ${listing(lines)}.${total} Pay me back whenever you can.`;
}
