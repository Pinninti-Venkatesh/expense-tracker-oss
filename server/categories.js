/**
 * Categories: the fixed built-in set plus any the user adds.
 *
 * The built-ins live in llm/extract.js (they seed the AI prompt); custom ones
 * live in the DB (db.customCategories). Everything else in the app asks here
 * for the effective list rather than importing the built-ins directly, so a
 * custom category is valid to store, offered in every picker, and fed to the AI
 * for auto-tagging future transactions.
 */
import { CATEGORIES as BASE_CATEGORIES } from './llm/extract.js';

export { BASE_CATEGORIES };

const MAX_LEN = 30;

/** Trim and collapse whitespace. Casing is preserved as the user typed it. */
export function normalizeCategory(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

/** Built-ins first, then custom in the order added; deduped case-insensitively. */
export function allCategories(db) {
  const seen = new Set(BASE_CATEGORIES.map((c) => c.toLowerCase()));
  const out = [...BASE_CATEGORIES];
  for (const c of db?.customCategories || []) {
    const key = c.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

/** The stored category matching `name` case-insensitively, or null. Lets the
 *  client send "food" and get back the canonical "Food". */
export function canonicalCategory(db, name) {
  const key = normalizeCategory(name).toLowerCase();
  if (!key) return null;
  return allCategories(db).find((c) => c.toLowerCase() === key) || null;
}

export const isValidCategory = (db, name) => canonicalCategory(db, name) !== null;

/**
 * Validates and adds a custom category. Returns the canonical name (existing or
 * newly created). Throws (with .status) on bad input. Idempotent: adding one
 * that already exists just returns it.
 */
export function addCategory(db, name) {
  const clean = normalizeCategory(name);
  if (!clean) { const e = new Error('Category name is required'); e.status = 400; throw e; }
  if (clean.length > MAX_LEN) {
    const e = new Error(`Category name must be ${MAX_LEN} characters or fewer`); e.status = 400; throw e;
  }
  // Denylist rather than a unicode-property allowlist: reject control chars and
  // a few markup/delimiter characters, and allow everything else (letters in any
  // script, numbers, spaces, &, -, etc.). Portable across Node versions.
  if (/[\u0000-\u001f<>]/.test(clean)) {
    const e = new Error('Category name has unsupported characters'); e.status = 400; throw e;
  }
  const existing = canonicalCategory(db, clean);
  if (existing) return existing; // already a built-in or custom — no-op

  db.customCategories ||= [];
  db.customCategories.push(clean);
  return clean;
}

/**
 * Removes a custom category. Built-ins can't be removed. Refuses if any expense
 * still uses it, unless `reassignTo` is given, in which case those expenses (and
 * any merchant rule pointing at it) are moved there first.
 */
export function removeCategory(db, name, reassignTo = null) {
  const clean = normalizeCategory(name);
  if (BASE_CATEGORIES.some((c) => c.toLowerCase() === clean.toLowerCase())) {
    const e = new Error('Built-in categories cannot be removed'); e.status = 400; throw e;
  }
  const idx = (db.customCategories || []).findIndex((c) => c.toLowerCase() === clean.toLowerCase());
  if (idx === -1) { const e = new Error('No such custom category'); e.status = 404; throw e; }

  const inUse = db.expenses.filter((e) => (e.category || '').toLowerCase() === clean.toLowerCase());
  if (inUse.length && !reassignTo) {
    const e = new Error(`${inUse.length} transaction(s) still use "${clean}". Reassign them first.`);
    e.status = 409; throw e;
  }

  if (inUse.length && reassignTo) {
    const target = canonicalCategory(db, reassignTo);
    if (!target) { const e = new Error(`Unknown category to reassign to: ${reassignTo}`); e.status = 400; throw e; }
    for (const exp of inUse) exp.category = target;
    for (const [k, v] of Object.entries(db.categoryRules || {})) {
      if (v.toLowerCase() === clean.toLowerCase()) db.categoryRules[k] = target;
    }
  }

  db.customCategories.splice(idx, 1);
  return { removed: clean, reassigned: inUse.length };
}

/**
 * Payment instruments a manual entry can be recorded against. Only 'Credit Card'
 * is settleable (money still has to move to the funding bank); the rest have
 * already left the account when they happen.
 */
export const PAYMENT_TYPES = ['Credit Card', 'UPI', 'Cash', 'Debit Card', 'Net Banking'];

export const canonicalPaymentType = (value) =>
  PAYMENT_TYPES.find((t) => t.toLowerCase() === String(value || '').trim().toLowerCase()) || null;
