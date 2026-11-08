import { ImapFlow } from 'imapflow';
import libmime from 'libmime';
import { requireContextUser } from '../context.js';
import logger from '../utils/logger.js';

/**
 * Gmail over IMAP, signed in with a Gmail app password: the setup that needs no
 * Google Cloud project. It answers the same calls as the Gmail API backend in
 * client.js, and hands back messages in the Gmail API's own shape, so
 * everything that reads a message (extractBody, isAuthenticSender, the
 * statement finder) works unchanged.
 *
 * Two Gmail IMAP extensions keep it equivalent to the API:
 *   X-GM-RAW    takes the very same search string as the API's `q`.
 *   X-GM-MSGID  is the API's message id, in decimal; the API writes it in hex.
 *               So ids recorded by either backend mean the same email, and a
 *               ledger can move between them without reprocessing anything.
 */

const HOST = 'imap.gmail.com';
const IDLE_CLOSE_MS = 30_000;

let factory = (options) => new ImapFlow(options);

/** Tests swap in a fake IMAP client. Never used by the app itself. */
export function __setImapForTests(make) {
  factory = make;
  for (const entry of connections.values()) entry.client.close?.();
  connections.clear();
}

// Account id -> { client, mailbox, password, timer, ready }.
const connections = new Map();
// Account id -> app password, set by prepare() for the account in context.
const credentials = new Map();

export const APP_PASSWORD_REJECTED = 'app_password_rejected';

export const toApiId = (gmMsgId) => BigInt(gmMsgId).toString(16);
const toGmMsgId = (apiId) => BigInt(`0x${apiId}`).toString();

/** True when Gmail refused the email and app password, as opposed to a network fault. */
export function isAuthFailure(err) {
  return Boolean(err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials/i.test(`${err?.responseText || ''} ${err?.message || ''}`));
}

function options(email, password) {
  return {
    host: HOST,
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    // A poll should fail fast rather than hang the scheduled run.
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
  };
}

/**
 * Signs in once to check an email and app password, then signs out. Returns
 * { ok: true } or { ok: false, reason: 'auth' | 'network', message }.
 */
export async function verifyAppPassword(email, password) {
  const client = factory(options(email, password));
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    client.close?.();
    if (isAuthFailure(err)) return { ok: false, reason: 'auth', message: err.responseText || err.message };
    return { ok: false, reason: 'network', message: err.message };
  }
}

/** Makes the account's app password available to the calls below. */
export function prepare(user, password) {
  credentials.set(user.id, { email: user.email, password });
  const open = connections.get(user.id);
  if (open && open.password !== password) closeFor(user.id);
}

/** Whether prepare() has run for the account in context. */
export function isPrepared() {
  const user = requireContextUser();
  return credentials.has(user.id);
}

export function forget(userId) {
  credentials.delete(userId);
  closeFor(userId);
}

function closeFor(userId) {
  const entry = connections.get(userId);
  if (!entry) return;
  connections.delete(userId);
  clearTimeout(entry.timer);
  entry.client.logout().catch(() => entry.client.close?.());
}

/**
 * "All Mail" is named per language ("[Gmail]/Todos", "[Google Mail]/All Mail"),
 * so it is found by its special-use flag. Like the API, it excludes spam and
 * trash.
 */
async function allMailPath(client) {
  const boxes = await client.list();
  const all = boxes.find((b) => b.specialUse === '\\All');
  if (!all) throw new Error('Gmail\'s "All Mail" folder is not visible over IMAP. In Gmail settings > Labels, tick "Show in IMAP" for All Mail.');
  return all.path;
}

/**
 * One connection per account, reused across the many calls a poll makes and
 * closed after a short idle. Calls for one account run one at a time, which is
 * what an IMAP connection needs.
 */
async function withMailbox(fn) {
  const user = requireContextUser();
  const cred = credentials.get(user.id);
  if (!cred) throw new Error('Gmail access is not set up for this account — sign in again');

  let entry = connections.get(user.id);
  if (!entry) {
    const client = factory(options(cred.email, cred.password));
    entry = { client, password: cred.password, chain: Promise.resolve(), timer: null };
    entry.ready = (async () => {
      await client.connect();
      entry.mailbox = await allMailPath(client);
      await client.mailboxOpen(entry.mailbox, { readOnly: true });
    })();
    client.on?.('close', () => { if (connections.get(user.id) === entry) connections.delete(user.id); });
    client.on?.('error', (err) => logger.warn(`IMAP connection for ${user.id} dropped`, err.message));
    connections.set(user.id, entry);
  }

  const run = entry.chain.then(async () => {
    clearTimeout(entry.timer);
    try {
      await entry.ready;
      return await fn(entry.client);
    } catch (err) {
      // A stable marker, so the poller can tell "sign in again" from a blip.
      // Gmail can also refuse mid-session, once the app password is removed.
      if (isAuthFailure(err)) {
        closeFor(user.id);
        throw new Error(`${APP_PASSWORD_REJECTED}: Gmail refused the app password`);
      }
      if (!entry.mailbox) connections.delete(user.id);
      throw err;
    }
  });
  entry.chain = run.then(() => {}, () => {});
  run.finally(() => {
    // Already closed and replaced (say, after a refused password): leave the new one be.
    if (connections.get(user.id) !== entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => closeFor(user.id), IDLE_CLOSE_MS);
    entry.timer.unref?.();
  }).catch(() => {});
  return run;
}

/* ---------- reading messages into the Gmail API's shape ---------- */

/** Parses a raw header block into [{ name, value }], unfolded and decoded. */
export function parseHeaders(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('binary') : String(raw || '');
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  const out = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    let value = line.slice(i + 1).trim();
    try {
      // Headers are 7-bit by rule but many senders put raw UTF-8 in them.
      value = libmime.decodeWords(Buffer.from(value, 'binary').toString('utf8'));
    } catch {
      // leave it as sent
    }
    out.push({ name: line.slice(0, i).trim(), value });
  }
  return out;
}

const filenameOf = (node) => node.dispositionParameters?.filename || node.parameters?.name || '';

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/**
 * Turns IMAP's BODYSTRUCTURE into the Gmail API's payload tree. Text bodies
 * are downloaded into body.data (base64url, as the API sends them); files keep
 * only an attachmentId, fetched later and only if wanted, so finding a
 * statement never downloads every PDF in the inbox.
 */
export async function toPayload(node, download, { root = false } = {}) {
  const mimeType = String(node.type || 'text/plain').toLowerCase();
  const part = {
    partId: node.part || '',
    mimeType,
    filename: filenameOf(node),
    body: { size: node.size || 0 },
  };

  if (node.childNodes?.length) {
    part.parts = [];
    for (const child of node.childNodes) part.parts.push(await toPayload(child, download));
    return part;
  }

  const isFile = part.filename || String(node.disposition || '').toLowerCase() === 'attachment';
  if (isFile) {
    part.body.attachmentId = node.part || '1';
  } else if (mimeType.startsWith('text/')) {
    // A message that is not multipart has its one body at part "1".
    const content = await download(node.part || (root ? '1' : ''));
    part.body.data = content.toString('base64url');
    part.body.size = content.length;
  }
  return part;
}

async function fetchByUid(client, uid, apiId) {
  const msg = await client.fetchOne(String(uid), { uid: true, internalDate: true, emailId: true, threadId: true, headers: true, bodyStructure: true }, { uid: true });
  if (!msg) throw new Error(`Message ${apiId} not found`);
  const download = async (part) => {
    const res = await client.download(String(uid), part || undefined, { uid: true });
    return res?.content ? streamToBuffer(res.content) : Buffer.alloc(0);
  };
  const payload = await toPayload(msg.bodyStructure, download, { root: true });
  payload.headers = parseHeaders(msg.headers);
  return {
    id: msg.emailId ? toApiId(msg.emailId) : apiId,
    threadId: msg.threadId ? toApiId(msg.threadId) : undefined,
    internalDate: String(new Date(msg.internalDate).getTime()),
    payload,
  };
}

async function uidFor(client, apiId) {
  const uids = await client.search({ emailId: toGmMsgId(apiId) }, { uid: true });
  if (!uids?.length) throw new Error(`Message ${apiId} not found`);
  return uids[0];
}

/* ---------- the calls client.js makes ---------- */

/**
 * Ids (Gmail API form) for a Gmail search, newest first, like the API's list.
 * `limit` caps how many are returned.
 */
export async function searchIds(query, { limit = Infinity } = {}) {
  return withMailbox(async (client) => {
    const uids = (await client.search({ gmraw: query }, { uid: true })) || [];
    if (!uids.length) return [];
    const wanted = uids.sort((a, b) => b - a).slice(0, Number.isFinite(limit) ? limit : undefined);
    const ids = [];
    for await (const msg of client.fetch(wanted.join(','), { uid: true, emailId: true }, { uid: true })) {
      if (msg.emailId) ids.push({ uid: msg.uid, id: toApiId(msg.emailId) });
    }
    return ids.sort((a, b) => b.uid - a.uid).map((m) => m.id);
  });
}

export async function getMessage(apiId) {
  return withMailbox(async (client) => fetchByUid(client, await uidFor(client, apiId), apiId));
}

export async function getAttachment(apiId, attachmentId) {
  return withMailbox(async (client) => {
    const uid = await uidFor(client, apiId);
    const res = await client.download(String(uid), attachmentId, { uid: true });
    if (!res?.content) throw new Error(`Attachment ${attachmentId} of ${apiId} not found`);
    return streamToBuffer(res.content);
  });
}
