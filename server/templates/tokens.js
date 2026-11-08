/**
 * Tokens with their positions, so a learned template can hand back the exact
 * original text of a field ("Amazon.in", not "Amazon . in").
 */
const TOKEN = /[A-Za-z]+|\d+(?:[.,]\d+)*|[^\sA-Za-z\d]/g;

export function tokenize(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TOKEN)) out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

const MONTH_OR_DAY = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|mon|tue|wed|thu|fri|sat|sun)$/i;

/**
 * Tokens that change from one email to the next even in an identical layout:
 * numbers, month names and weekdays. They are never learned as fixed text —
 * otherwise a template learned in September would stop matching in October.
 */
export const isVariable = (token) => /\d/.test(token) || MONTH_OR_DAY.test(token);

export const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
