/**
 * How alert templates are earned, used and lost. Every function works on the
 * account's ledger in place; the poll calls them inside its store.mutate.
 *
 *   example  the model reads an alert from a DKIM-verified sender; it is kept
 *   learned  two examples line up into a template, on trial
 *   trial    the model keeps reading; the template must agree every time
 *   live     after TRIAL_AGREEMENTS agreements the template reads alone, with the
 *            model re-checking one alert in SPOT_CHECK_EVERY
 *   retired  one disagreement, at any stage, and it is never used again
 *
 * The merchant a template reads is the bank's raw text ("SWIGGY BANGALORE IN").
 * Its clean name and category come from what the model said the last time it
 * saw that raw text; a merchant never seen before still goes to the model.
 *
 * A template can also be adopted from the shared library (library.js), when
 * other accounts proved the same format. It starts on a shorter trial, since
 * several accounts' models already agreed with it, but this account's model
 * still grades it, and a retired one is never adopted again.
 */
import { induceTemplate, matchTemplate } from './alerts.js';
import { keyOf } from './tokens.js';

export const TRIAL_AGREEMENTS = 5;
export const SHARED_TRIAL_AGREEMENTS = 2;
export const SPOT_CHECK_EVERY = 50;

const MAX_EXAMPLES = 3;
const MAX_TEMPLATES = 4;
const MAX_ALIASES = 3000;
const MAX_RETIRED_SHARED = 50;

const newId = () => `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** The first working template that reads this email: { templateId, state, uses, constants, fields }. */
export function findTemplateRead(db, sender, text) {
  for (const t of db.alertTemplates?.[sender] || []) {
    if (t.state === 'retired') continue;
    const fields = matchTemplate(t, text);
    if (fields) return { templateId: t.id, state: t.state, uses: t.uses, constants: t.constants, fields };
  }
  return null;
}

export const aliasFor = (db, raw) => db.merchantAliases?.[keyOf(raw)] || null;

/** True when a template can read this email without the model. */
export function canSkipModel(hit, alias) {
  return Boolean(hit && alias && hit.state === 'live' && (hit.uses + 1) % SPOT_CHECK_EVERY !== 0);
}

/** The extraction a template produces, in the same shape the model returns. */
export function extractionFromTemplate(hit, alias) {
  return {
    amount: hit.fields.amount,
    currency: 'INR',
    merchant: alias.merchant,
    bank: hit.constants.bank,
    cardLast4: hit.fields.last4 || hit.constants.cardLast4 || null,
    paymentType: hit.constants.paymentType,
    category: alias.category || 'General',
    categorySource: 'template',
    reasoning: 'Read with a template learned from earlier alerts from this sender.',
  };
}

export function noteTemplateUse(db, sender, templateId) {
  const t = (db.alertTemplates?.[sender] || []).find((x) => x.id === templateId);
  if (t) t.uses += 1;
}

function rememberAlias(db, raw, extraction) {
  const key = keyOf(raw);
  if (!key || !extraction?.merchant) return;
  db.merchantAliases ||= {};
  db.merchantAliases[key] = { merchant: extraction.merchant, category: extraction.category || 'General' };
  const keys = Object.keys(db.merchantAliases);
  for (let i = 0; i < keys.length - MAX_ALIASES; i++) delete db.merchantAliases[keys[i]];
}

/** The template read and the model's answer describe the same spend. */
function agrees(hit, extracted) {
  if (!extracted || (extracted.currency || 'INR') !== 'INR') return false;
  if (Math.abs(Number(extracted.amount) - hit.fields.amount) >= 0.005) return false;
  if (keyOf(extracted.bank) !== keyOf(hit.constants.bank)) return false;
  if (keyOf(extracted.paymentType) !== keyOf(hit.constants.paymentType)) return false;
  const card = hit.fields.last4 || hit.constants.cardLast4 || null;
  if ((extracted.cardLast4 || null) !== card) return false;
  const first = keyOf(extracted.merchant).split(' ')[0];
  return first.length >= 2 && keyOf(hit.fields.merchantRaw).includes(first);
}

/**
 * Adds a format from the shared library ({ key, form }) to this account's
 * templates, on trial. Returns the template, or null when this account already
 * has it or retired it before.
 */
export function adoptShared(db, sender, { key, form }) {
  db.alertTemplates ||= {};
  const templates = (db.alertTemplates[sender] ||= []);
  if (templates.some((t) => t.sharedKey === key) || (db.retiredSharedKeys || []).includes(key)) return null;

  const template = {
    id: newId(),
    parts: structuredClone(form.parts),
    constants: { bank: form.bank, paymentType: form.paymentType, cardLast4: null },
    state: 'trial',
    agree: 0,
    uses: 0,
    trialAgreements: SHARED_TRIAL_AGREEMENTS,
    origin: 'shared',
    sharedKey: key,
    createdAt: new Date().toISOString(),
  };
  templates.push(template);
  prune(templates);
  return template;
}

function prune(templates) {
  while (templates.length > MAX_TEMPLATES) {
    const retired = templates.findIndex((t) => t.state === 'retired');
    templates.splice(retired === -1 ? 0 : retired, 1);
  }
}

/**
 * Learns from one model answer for a DKIM-verified sender. `hit` is the template
 * read made before asking, if any. Returns what happened, for logs and tests:
 * 'agreed' | 'promoted' | 'retired' | 'learned' | 'example' | 'skipped' | 'gone'.
 */
export function learnFromModel(db, { sender, text, extracted, hit }) {
  db.alertTemplates ||= {};
  db.alertExamples ||= {};
  const templates = (db.alertTemplates[sender] ||= []);

  if (hit) {
    const t = templates.find((x) => x.id === hit.templateId);
    if (!t) return 'gone';
    if (agrees(hit, extracted)) {
      t.agree += 1;
      t.uses += 1;
      rememberAlias(db, hit.fields.merchantRaw, extracted);
      if (t.state === 'trial' && t.agree >= (t.trialAgreements || TRIAL_AGREEMENTS)) {
        t.state = 'live';
        t.liveAt = new Date().toISOString();
        return 'promoted';
      }
      return 'agreed';
    }
    t.state = 'retired';
    t.retiredAt = new Date().toISOString();
    if (t.sharedKey) db.retiredSharedKeys = [...(db.retiredSharedKeys || []), t.sharedKey].slice(-MAX_RETIRED_SHARED);
    return 'retired';
  }

  if (!extracted || (extracted.currency || 'INR') !== 'INR') return 'skipped';

  const example = {
    text: String(text || '').slice(0, 4000),
    amount: Number(extracted.amount),
    merchant: extracted.merchant,
    category: extracted.category,
    cardLast4: extracted.cardLast4 || null,
    bank: extracted.bank,
    paymentType: extracted.paymentType,
  };
  const examples = (db.alertExamples[sender] ||= []);

  for (const earlier of [...examples].reverse()) {
    const learned = induceTemplate(earlier, example);
    if (!learned) continue;
    templates.push({ ...learned.template, id: newId() });
    prune(templates);
    rememberAlias(db, learned.raw.a, earlier);
    rememberAlias(db, learned.raw.b, example);
    // The pair is spent. Keeping raw email text around longer than it's needed
    // would only be more personal data in the ledger.
    db.alertExamples[sender] = examples.filter((e) => e !== earlier);
    return 'learned';
  }

  examples.push(example);
  while (examples.length > MAX_EXAMPLES) examples.shift();
  return 'example';
}
