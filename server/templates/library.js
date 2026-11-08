/**
 * Alert formats shared between accounts, without sharing anyone's email.
 *
 * What travels is a learned template's shape: its fixed wording, where the
 * amount, merchant and card sit, and the bank and payment type it reads. Never
 * an amount, merchant, card number, date, time or reference: those are
 * variable tokens (tokens.js), and a template holds none of them. Two more
 * guards cover what a template can hold:
 *
 *   1. Scrubbing. Words from the contributor's own name and email address
 *      become gaps before anything leaves their ledger, so "Dear Asha Rao" is
 *      offered as "Dear …".
 *   2. k-anonymity. A format reaches other accounts only after
 *      MIN_CONTRIBUTORS different accounts learned exactly that form on their
 *      own. Wording unique to one person, like a name the scrub missed, can't
 *      match anyone else's form, so it never gets that far. Until then the
 *      library holds a keyed hash of the form and keyed hashes of who offered
 *      it: no wording at all.
 *
 * Only proven formats are offered: live in the contributor's ledger (it agreed
 * with the model TRIAL_AGREEMENTS times), from a sender Gmail verified with
 * DKIM, at a known bank domain, learned there rather than adopted. Nothing
 * reaches the library from the browser; offers come only from the server's poll.
 *
 * A receiving account still checks. An adopted format starts on a short trial
 * graded by that account's own model; one disagreement retires it there and
 * counts against it here, and DISPUTES_TO_WITHDRAW accounts disputing it
 * withdraw it for everyone, for good.
 */
import crypto from 'node:crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import { bankForSender } from '../banks.js';
import { matchTemplate } from './alerts.js';
import { keyOf } from './tokens.js';
import { libraryBackend } from './libraryStore.js';

// At least as strict as learning a template in the first place (alerts.js).
const MIN_FIXED_WORDS = 6;
export const DISPUTES_TO_WITHDRAW = 2;
const MAX_CONTRIBUTORS_KEPT = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;

let hashKey = null;

/**
 * The library's own key, derived from TOKEN_ENCRYPTION_KEY. Hashes made with
 * it can't be recomputed from a guessed form or account id without the server's
 * secret. Rotating that secret only restarts the counting.
 */
function libraryKey() {
  hashKey ||= Buffer.from(crypto.hkdfSync('sha256', Buffer.from(config.security.tokenEncryptionKey || '', 'base64'), 'template-library', 'v1', 32));
  return hashKey;
}

const keyed = (label, value) => crypto.createHmac('sha256', libraryKey()).update(`${label}\n${value}`).digest('hex');

export const contributorId = (accountId) => keyed('contributor', accountId);

/** Words from a person's own name and email address, lower-cased. */
export function personalWords({ name, email } = {}) {
  const local = String(email || '').split('@')[0];
  return new Set(`${name || ''} ${local}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2));
}

/**
 * The shareable form of a learned template, or null when it can't be shared
 * safely. See the top of this file for every rule.
 */
export function sharableForm(template, sender, person = {}) {
  if (!template || template.state !== 'live' || template.origin === 'shared') return null;
  // A card number fixed in the template is this person's card.
  if (template.constants?.cardLast4) return null;
  const address = String(sender || '').toLowerCase().trim();
  if (!bankForSender(address)) return null;

  const scrub = personalWords(person);
  const source = template.parts || [];
  const parts = [];
  source.forEach((p, k) => {
    if (!p.lit) {
      parts.push(p.field ? { field: p.field } : { wild: true });
      return;
    }
    let words = p.lit;
    // The opening and closing runs are anchors, and an anchor can just be
    // shorter: a personal word there is dropped with everything beyond it.
    if (k === 0) words = words.slice(words.findLastIndex((w) => scrub.has(w)) + 1);
    if (k === source.length - 1) {
      const first = words.findIndex((w) => scrub.has(w));
      if (first !== -1) words = words.slice(0, first);
    }
    // Elsewhere a personal word becomes a gap.
    let run = [];
    for (const word of words) {
      if (!scrub.has(word)) {
        run.push(word);
        continue;
      }
      if (run.length) parts.push({ lit: run });
      run = [];
      parts.push({ wild: true });
    }
    if (run.length) parts.push({ lit: run });
  });

  const merged = [];
  for (const p of parts) {
    if (p.wild && merged[merged.length - 1]?.wild) continue;
    merged.push(p);
  }

  // matchTemplate reads the text between two runs of fixed words, so two gaps
  // in a row can't be told apart, and the form must open and close on words.
  for (let i = 1; i < merged.length; i++) {
    if (!merged[i].lit && !merged[i - 1].lit) return null;
  }
  if (!merged[0]?.lit || merged[0].lit.length < 2 || !merged[merged.length - 1]?.lit) return null;
  if (merged.reduce((n, p) => n + (p.lit ? p.lit.length : 0), 0) < MIN_FIXED_WORDS) return null;
  const fields = new Set(merged.filter((p) => p.field).map((p) => p.field));
  if (!fields.has('amount') || !fields.has('merchant')) return null;

  return {
    sender: address,
    bank: template.constants?.bank || null,
    paymentType: template.constants?.paymentType || null,
    parts: merged,
  };
}

/** Accounts that learned the same format get the same key, whatever their bank or card. */
export function formKey(form) {
  return keyed('form', JSON.stringify([form.sender, keyOf(form.bank), keyOf(form.paymentType), form.parts]));
}

/* ---------- record transitions (pure) ---------- */

/** Counts one account's offer. Publishes the form at the threshold. */
export function withContribution(record, { key, contributor, form }, { minContributors, now }) {
  const rec = record
    ? { ...record, contributors: [...(record.contributors || [])], disputes: [...(record.disputes || [])] }
    : { key, status: 'pending', contributors: [], disputes: [], createdAt: now };

  if (rec.status === 'withdrawn') return { record: null, outcome: 'withdrawn' };
  if (rec.contributors.includes(contributor)) return { record: null, outcome: 'already' };

  if (rec.contributors.length < MAX_CONTRIBUTORS_KEPT) rec.contributors.push(contributor);
  if (rec.status === 'pending' && rec.contributors.length >= minContributors) {
    return { record: { ...rec, status: 'published', form, sender: form.sender, publishedAt: now }, outcome: 'published' };
  }
  return { record: rec, outcome: rec.status === 'published' ? 'counted' : 'pending' };
}

/** Counts one account's disagreement with a published form. Withdraws it at the threshold. */
export function withDispute(record, contributor, { now }) {
  if (!record || record.status !== 'published') return { record: null, outcome: 'ignored' };
  if ((record.disputes || []).includes(contributor)) return { record: null, outcome: 'already' };

  const disputes = [...(record.disputes || []), contributor];
  if (disputes.length >= DISPUTES_TO_WITHDRAW) {
    return { record: { ...record, disputes, status: 'withdrawn', form: null, sender: null, withdrawnAt: now }, outcome: 'withdrawn' };
  }
  return { record: { ...record, disputes }, outcome: 'disputed' };
}

/* ---------- the library ---------- */

let cache = { at: 0, bySender: null };
const forgetCache = () => { cache = { at: 0, bySender: null }; };

/** Offers a live template learned by this account. Returns { key, outcome } or { outcome: 'unsharable' }. */
export async function contribute(accountId, sender, template, person) {
  const form = sharableForm(template, sender, person);
  if (!form) return { outcome: 'unsharable' };

  const key = formKey(form);
  const contributor = contributorId(accountId);
  const now = new Date().toISOString();
  let outcome;
  await libraryBackend().update(key, (record) => {
    const result = withContribution(record, { key, contributor, form }, { minContributors: config.library.minContributors, now });
    outcome = result.outcome;
    return result.record;
  });
  if (outcome === 'published') {
    forgetCache();
    logger.info('Template library: a format was published');
  }
  return { key, outcome };
}

/** Records that this account's model disagreed with a shared format. */
export async function dispute(accountId, key) {
  const contributor = contributorId(accountId);
  let outcome;
  await libraryBackend().update(key, (record) => {
    const result = withDispute(record, contributor, { now: new Date().toISOString() });
    outcome = result.outcome;
    return result.record;
  });
  if (outcome === 'withdrawn') {
    forgetCache();
    logger.warn('Template library: a format was withdrawn after disputes');
  }
  return { outcome };
}

async function publishedBySender() {
  if (cache.bySender && Date.now() - cache.at < CACHE_TTL_MS) return cache.bySender;
  const bySender = new Map();
  for (const record of await libraryBackend().listPublished()) {
    if (!record.form?.sender) continue;
    if (!bySender.has(record.form.sender)) bySender.set(record.form.sender, []);
    bySender.get(record.form.sender).push({ key: record.key, form: record.form });
  }
  cache = { at: Date.now(), bySender };
  return bySender;
}

/** A published format from this sender that reads this email, skipping keys the account retired. */
export async function findShared(sender, text, { exclude = [] } = {}) {
  const candidates = (await publishedBySender()).get(String(sender || '').toLowerCase()) || [];
  const skip = new Set(exclude);
  for (const candidate of candidates) {
    if (skip.has(candidate.key)) continue;
    if (matchTemplate(candidate.form, text)) return candidate;
  }
  return null;
}

/** Tests only. */
export function __resetLibraryCacheForTests() {
  forgetCache();
}
