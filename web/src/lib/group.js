/** Newest first: by date, then by alert time or creation time within a day. */
export function newestFirst(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const ta = a.at || a.createdAt || '';
  const tb = b.at || b.createdAt || '';
  return ta < tb ? 1 : ta > tb ? -1 : 0;
}

/** [[date, rows], …] newest day first. */
export function groupByDay(rows) {
  const groups = new Map();
  for (const row of [...rows].sort(newestFirst)) {
    if (!groups.has(row.date)) groups.set(row.date, []);
    groups.get(row.date).push(row);
  }
  return [...groups.entries()];
}
