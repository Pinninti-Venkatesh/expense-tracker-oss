import { google } from 'googleapis';
import { getAuthedClient } from '../auth/google-auth.js';
import logger from '../utils/logger.js';
import { localDate } from '../utils/datetime.js';
import { buildQuery } from './query.js';
import { isAuthenticSender } from './authResults.js';
import config from '../config.js';
import * as imap from './imap.js';

export { isAuthenticSender };

// The alert search, for any bank, is built in query.js.
export { buildQuery };

// MAIL_ACCESS=app-password reads the same mailbox over IMAP (imap.js), which
// answers in the API's message shape, so only the fetching below branches.
const overImap = () => config.mail.access === 'app-password';

function getGmail() {
  const auth = getAuthedClient();
  if (!auth) throw new Error('Not authenticated with Google. Visit /api/auth first.');
  return google.gmail({ version: 'v1', auth });
}

/**
 * Lists every message matching the query, following Gmail's pagination.
 * The API returns at most 500 ids per page; a short poll fits in one page, but a
 * multi-month backfill does not — without following nextPageToken we would
 * silently return only the first page and appear to have scanned everything.
 * `maxPages` is a runaway guard, not an expected limit.
 */
export async function listMessages(afterEpochSeconds, knownSenders, { maxPages = 40 } = {}) {
  const q = buildQuery(afterEpochSeconds, knownSenders);
  logger.debug('Gmail query', q);
  if (overImap()) return (await imap.searchIds(q, { limit: maxPages * 500 })).map((id) => ({ id }));

  const gmail = getGmail();

  const all = [];
  let pageToken;
  let pages = 0;

  do {
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 500, pageToken });
    if (res.data.messages) all.push(...res.data.messages);
    pageToken = res.data.nextPageToken;
    pages++;
  } while (pageToken && pages < maxPages);

  if (pageToken) {
    logger.warn(`Stopped paginating after ${maxPages} pages (${all.length} messages) — more may remain`);
  }

  return all;
}

export async function getMessage(messageId) {
  if (overImap()) return imap.getMessage(messageId);
  const gmail = getGmail();
  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  return res.data;
}

function header(message, name) {
  const found = message.payload?.headers?.find((h) => h.name.toLowerCase() === name);
  return found?.value || '';
}

export function extractSender(message) {
  const value = header(message, 'from');
  const angled = value.match(/<(.+?)>/);
  return (angled ? angled[1] : value).toLowerCase().trim();
}

export function extractSubject(message) {
  return header(message, 'subject');
}

/** The email's own received date as YYYY-MM-DD, in the user's timezone (not the
 *  server's UTC — see server/utils/datetime.js). */
export function extractDate(message) {
  return localDate(parseInt(message.internalDate, 10));
}

/** Full receipt timestamp (ISO), used to detect a bank's double-sent alerts. */
export function extractTimestamp(message) {
  return new Date(parseInt(message.internalDate, 10)).toISOString();
}

function decodeBase64(data) {
  return Buffer.from(data, 'base64').toString('utf-8');
}

function findPart(parts, mimeType) {
  for (const part of parts) {
    if (part.mimeType === mimeType) return part;
    if (part.parts) {
      const nested = findPart(part.parts, mimeType);
      if (nested) return nested;
    }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|div|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Gmail stores bodies base64url-encoded; prefer text/plain, fall back to stripped HTML. */
export function extractBody(message) {
  const payload = message.payload;
  if (!payload) return '';

  if (payload.body?.data) {
    const decoded = decodeBase64(payload.body.data);
    return payload.mimeType === 'text/html' ? stripHtml(decoded) : decoded;
  }

  if (payload.parts) {
    const plain = findPart(payload.parts, 'text/plain');
    if (plain?.body?.data) return decodeBase64(plain.body.data);

    const html = findPart(payload.parts, 'text/html');
    if (html?.body?.data) return stripHtml(decodeBase64(html.body.data));
  }

  return '';
}

/**
 * Ids only, for an arbitrary Gmail query — one list call, no message bodies.
 * Prefer this when you can decide from the id alone (already-imported, say)
 * whether a message is worth fetching at all.
 */
export async function searchMessageIds(query, { maxResults = 25 } = {}) {
  if (overImap()) return imap.searchIds(query, { limit: maxResults });
  const gmail = getGmail();
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  return (res.data.messages || []).map((m) => m.id);
}

/** Hydrates ids into full messages, one round-trip each — so pass only what you need. */
export async function getMessages(ids) {
  const out = [];
  if (overImap()) {
    for (const id of ids) out.push(await imap.getMessage(id));
    return out;
  }
  const gmail = getGmail();
  for (const id of ids) {
    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    out.push(full.data);
  }
  return out;
}

/**
 * Runs an arbitrary Gmail search and returns a full message per hit. Used to
 * locate specific documents like the monthly bank statement, independently of
 * the transaction-alert poller.
 */
export async function searchMessages(query, { maxResults = 25 } = {}) {
  return getMessages(await searchMessageIds(query, { maxResults }));
}

/** Flattens a message's MIME tree to the parts that are file attachments. */
export function listAttachments(message) {
  const out = [];
  const walk = (part) => {
    if (!part) return;
    const filename = part.filename;
    const attachmentId = part.body?.attachmentId;
    if (filename && attachmentId) {
      out.push({ filename, mimeType: part.mimeType, attachmentId, size: part.body.size });
    }
    (part.parts || []).forEach(walk);
  };
  walk(message.payload);
  return out;
}

/** Downloads one attachment's bytes as a Buffer. */
export async function getAttachment(messageId, attachmentId) {
  if (overImap()) return imap.getAttachment(messageId, attachmentId);
  const gmail = getGmail();
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  // Gmail returns URL-safe base64.
  return Buffer.from(res.data.data, 'base64');
}
