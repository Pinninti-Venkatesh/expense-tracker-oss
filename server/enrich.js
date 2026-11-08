import { google } from 'googleapis';
import { getAuthedClient } from './auth/google-auth.js';
import * as gmail from './gmail/client.js';
import { summarizeOrderEmail } from './llm/summarize.js';
import { isFatalLlmError } from './llm/client.js';
import { merchantKey } from './learning/corrections.js';
import * as store from './drive/store.js';
import { requireContextUser } from './context.js';
import logger from './utils/logger.js';

// Accounts with an enrichment run in flight. Per account, so one user's long
// run never blocks another's.
const running = new Set();

/**
 * Merchants whose order emails come from a domain you would not guess from the
 * name on the card statement. Everything else is found by the generic
 * `from:<merchant word>` search, which matches sender name or address.
 */
const DOMAIN_ALIASES = {
  zepto: ['zeptonow.com'],
  blinkit: ['blinkit.com', 'grofers.com'],
  swiggy: ['swiggy.in'],
  instamart: ['swiggy.in'],
  zomato: ['zomato.com'],
  myntra: ['myntra.com'],
  amazon: ['amazon.in'],
  'amazon pay': ['amazon.in'],
  flipkart: ['flipkart.com'],
  ajio: ['ajio.com'],
  nykaa: ['nykaa.com'],
  uber: ['uber.com'],
  ola: ['olacabs.com'],
  rapido: ['rapido.bike'],
  bigbasket: ['bigbasket.com'],
  dunzo: ['dunzo.com'],
  bookmyshow: ['bookmyshow.com'],
  makemytrip: ['makemytrip.com'],
  agoda: ['agoda.com'],
  apple: ['apple.com'],
  netflix: ['netflix.com'],
  lenskart: ['lenskart.com'],
  meesho: ['meesho.com'],
};

/** Words that are not the merchant's identity and would make the search useless. */
const STOP_WORDS = new Set([
  'ltd', 'limited', 'pvt', 'private', 'india', 'in', 'the', 'and', 'services',
  'service', 'technologies', 'technology', 'solutions', 'online', 'store',
  'retail', 'company', 'co', 'inc', 'llp', 'enterprises', 'marketplace',
]);

/** Builds the Gmail `from:` alternatives to look for this merchant's own mail. */
export function senderCandidates(merchant) {
  const key = merchantKey(merchant);
  if (!key) return [];

  const domains = new Set();
  for (const [alias, list] of Object.entries(DOMAIN_ALIASES)) {
    if (key.includes(alias)) list.forEach((d) => domains.add(d));
  }

  // Generic fallback: the merchant's own distinctive words. Gmail's from:
  // matches the sender display name as well as the address, so "from:myntra"
  // finds mail from "Myntra <orders@myntra.com>".
  const words = key
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 2);

  return [...domains, ...words];
}

/** Search window around the charge. Tight when we have a timestamp, else the whole day. */
function windowFor(expense) {
  if (expense.at) {
    const t = new Date(expense.at).getTime();
    return { after: Math.floor((t - 6 * 3600e3) / 1000), before: Math.floor((t + 48 * 3600e3) / 1000) };
  }
  const day = new Date(`${expense.date}T00:00:00`).getTime();
  return { after: Math.floor((day - 6 * 3600e3) / 1000), before: Math.floor((day + 72 * 3600e3) / 1000) };
}

/**
 * Finds the merchant's own email closest in time to the charge.
 * Returns null when the merchant has no findable mail (a physical shop, say).
 */
export async function findOrderEmail(expense) {
  const api = google.gmail({ version: 'v1', auth: getAuthedClient() });

  const candidates = senderCandidates(expense.merchant);
  if (!candidates.length) return null;

  const { after, before } = windowFor(expense);
  const q = `(${candidates.map((c) => `from:${c}`).join(' OR ')}) after:${after} before:${before}`;

  const res = await api.users.messages.list({ userId: 'me', q, maxResults: 10 });
  const messages = res.data.messages || [];
  if (!messages.length) return null;

  // Prefer the message nearest the charge — a merchant may send several
  // (confirmation, then dispatch, then delivered) and the first is the order.
  const target = expense.at ? new Date(expense.at).getTime() : new Date(`${expense.date}T12:00:00`).getTime();
  let best = null;

  for (const { id } of messages) {
    const full = await api.users.messages.get({ userId: 'me', id, format: 'full' });
    const distance = Math.abs(parseInt(full.data.internalDate, 10) - target);
    if (!best || distance < best.distance) best = { distance, message: full.data };
  }

  return best?.message || null;
}

/**
 * Works out what an expense was actually for. Returns a patch rather than
 * mutating: the caller must apply it inside store.mutate(), because the store
 * detects changes by diffing and a mutation made beforehand would look like a
 * no-op and never reach Drive.
 *
 * Always sets enrichedAt so a merchant with no findable mail (a physical shop)
 * isn't looked up again on every run.
 */
export async function computeEnrichment(expense) {
  const enrichedAt = new Date().toISOString();

  const message = await findOrderEmail(expense);
  if (!message) return { enrichedAt, enrichStatus: 'no_order_email' };

  const summary = await summarizeOrderEmail({
    subject: gmail.extractSubject(message),
    body: gmail.extractBody(message),
    merchant: expense.merchant,
  });
  if (!summary) return { enrichedAt, enrichStatus: 'not_an_order' };

  return {
    description: summary.summary,
    items: summary.items,
    orderEmailId: message.id,
    enrichedAt,
    enrichStatus: 'ok',
  };
}

/** Applies a patch to one expense and writes through to Drive. */
export async function applyEnrichment(expenseId, patch) {
  await store.mutate((d) => {
    const target = d.expenses.find((e) => e.id === expenseId);
    if (target) Object.assign(target, patch);
  });
}

/**
 * Enriches every expense that hasn't been looked at yet. Long-running, so the
 * caller runs it in the background; results land on the next refetch.
 */
export async function enrichAll({ force = false, onProgress } = {}) {
  const { id: accountId } = requireContextUser();
  if (running.has(accountId)) return { skipped: 'already_running' };
  running.add(accountId);

  const result = { considered: 0, enriched: 0, noEmail: 0, failed: 0 };

  try {
    const db = await store.init();
    const todo = db.expenses.filter((e) => e.source === 'email' && (force || !e.enrichedAt));
    result.considered = todo.length;
    logger.info(`enrich: ${todo.length} expense(s) to look up`);

    let done = 0;
    for (const expense of todo) {
      try {
        const patch = await computeEnrichment(expense);
        // Persist per expense so a long run leaves durable progress behind.
        await applyEnrichment(expense.id, patch);

        if (patch.enrichStatus === 'ok') result.enriched++;
        else result.noEmail++;
      } catch (err) {
        logger.error(`enrich failed for ${expense.id}`, err.message);
        result.failed++;
        if (isFatalLlmError(err)) {
          result.abortedReason = err.message;
          break;
        }
      } finally {
        done++;
        if (onProgress && (done % 10 === 0 || done === todo.length)) onProgress({ done, ...result });
      }
    }

    logger.info('enrich complete', result);
    return result;
  } finally {
    running.delete(accountId);
  }
}
