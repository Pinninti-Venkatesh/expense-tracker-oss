import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getAuthedClient } from '../auth/google-auth.js';
import { requireContextUser } from '../context.js';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * Each account's ledger: one JSON file in that user's own Google Drive, created
 * by this app (so the drive.file scope can reach it and nothing else).
 *
 * App-password installs (MAIL_ACCESS=app-password) have no Drive access, so
 * the same file lives on this machine instead, one per account in LEDGER_DIR.
 *
 * The store API is unchanged from the single-user app — init(), read(),
 * mutate() — but every call resolves to the account in context. There is no
 * way to name another account's ledger, and no ledger at all outside a context.
 */

const EMPTY_DB = {
  version: 1,
  expenses: [],
  processedEmailIds: [],
  knownSenders: [],
  corrections: [],
  categoryRules: {},
  customCategories: [],
  people: [],
  ledger: { entries: [] },
  processedUpiRefs: [],
  processedStatementIds: [],
  statementIgnores: [],
  // Per sender: how many spends and non-spends it has sent. See gmail/prefilter.js.
  senderStats: {},
  // Learned readers that let known formats skip the model. See server/templates/.
  alertTemplates: {},
  alertExamples: {},
  merchantAliases: {},
  // Shared formats this account's model disagreed with, never adopted again.
  retiredSharedKeys: [],
  statementLayouts: {},
  loans: [],
  // firstSyncAt: when the first sync (1st of last month onward) finished.
  meta: { firstSyncAt: null },
  settings: { settleEnabled: false },
  // PIN lock: hash + salt only, never the PIN itself. See auth/pin.js.
  security: { pin: null, failed: { count: 0, lockedUntil: null } },
};

// Account id -> { cache, fileId, loading, writeChain, pending, lastUsed }.
const accounts = new Map();

let driveOverride = null;

/** Tests swap Drive for an in-memory fake. Never used by the app itself. */
export function __setDriveForTests(factory) {
  driveOverride = factory;
  accounts.clear();
}

function getDrive() {
  if (driveOverride) return driveOverride();
  return google.drive({ version: 'v3', auth: getAuthedClient() });
}

/** Drops the least recently used idle ledgers once too many are held in memory. */
function evictIdle(keepId) {
  if (accounts.size <= config.store.maxCachedAccounts) return;
  const idle = [...accounts.values()]
    .filter((s) => s.id !== keepId && s.pending === 0 && !s.loading)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const s of idle) {
    if (accounts.size <= config.store.maxCachedAccounts) break;
    accounts.delete(s.id);
  }
}

function slot() {
  const { id } = requireContextUser();
  let s = accounts.get(id);
  if (!s) {
    s = { id, cache: null, fileId: null, loading: null, writeChain: Promise.resolve(), pending: 0, lastUsed: 0 };
    accounts.set(id, s);
    evictIdle(id);
  }
  s.lastUsed = Date.now();
  return s;
}

/* ---------- on this machine (app-password installs) ---------- */

const onDisk = () => config.mail.access === 'app-password' && !driveOverride;

function localPath() {
  const { id } = requireContextUser();
  return path.join(config.ledger.dir, `${String(id).replace(/[^\w.-]/g, '_')}.json`);
}

function writeLocal(file, db) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write then rename, so a crash mid-write never leaves half a ledger.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const local = {
  findOrCreate() {
    const file = localPath();
    if (!fs.existsSync(file)) {
      writeLocal(file, EMPTY_DB);
      logger.info('Created a ledger file on this machine');
    }
    return file;
  },
  download: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
  upload: (file, db) => writeLocal(file, db),
  remove: (file) => fs.rmSync(file, { force: true }),
};

/* ---------- in the user's Google Drive ---------- */

async function findOrCreateFile() {
  if (onDisk()) return local.findOrCreate();
  const drive = getDrive();
  const name = config.drive.fileName.replace(/'/g, "\\'");

  const res = await drive.files.list({
    q: `name = '${name}' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  if (res.data.files?.length) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: { name: config.drive.fileName, mimeType: 'application/json' },
    media: { mimeType: 'application/json', body: JSON.stringify(EMPTY_DB, null, 2) },
    fields: 'id',
  });
  logger.info('Created a ledger file in the user\'s Drive');
  return created.data.id;
}

async function download(fileId) {
  if (onDisk()) return local.download(fileId);
  const res = await getDrive().files.get({ fileId, alt: 'media' }, { responseType: 'text' });
  // googleapis hands back a parsed object when it detects JSON, a string otherwise.
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

async function upload(fileId, db) {
  if (onDisk()) return local.upload(fileId, db);
  await getDrive().files.update({
    fileId,
    media: { mimeType: 'application/json', body: Readable.from([JSON.stringify(db, null, 2)]) },
  });
}

/**
 * Loads the account's ledger into memory. Safe to call repeatedly and
 * concurrently: simultaneous callers share one download.
 */
export async function init() {
  const s = slot();
  if (s.cache) return s.cache;

  s.loading ||= (async () => {
    s.fileId = await findOrCreateFile();
    const loaded = await download(s.fileId);
    // Merge against EMPTY_DB so a file written by an older version has every key.
    s.cache = { ...structuredClone(EMPTY_DB), ...loaded };
    return s.cache;
  })();

  try {
    return await s.loading;
  } finally {
    s.loading = null; // a failure is retried by the next caller rather than cached
  }
}

/** Synchronous read of the account's cached ledger. Call init() first. */
export function read() {
  const s = slot();
  if (!s.cache) throw new Error('Store not initialised for this account — call init() first.');
  return s.cache;
}

/**
 * Applies `mutateFn` to the account's ledger, then writes the whole file back to
 * Drive before resolving. Write-through rather than periodic sync: Cloud Run
 * kills idle containers, so anything not yet flushed would be lost. Writes for
 * one account are serialised; different accounts never wait on each other.
 */
export function mutate(mutateFn) {
  const s = slot();
  s.pending += 1;

  const run = s.writeChain.then(async () => {
    if (!s.cache) await init();

    const before = JSON.stringify(s.cache);
    const result = mutateFn(s.cache);
    if (JSON.stringify(s.cache) === before) return result; // no-op, skip the write

    try {
      await upload(s.fileId, s.cache);
    } catch (err) {
      // Roll back so memory never claims a write that Drive rejected.
      s.cache = JSON.parse(before);
      logger.error('Drive write failed, rolled back in-memory state', err.message);
      throw err;
    }
    return result;
  });

  // The chain must survive a failed write, or every later write for this
  // account would be skipped. Callers still see the real outcome via `run`.
  s.writeChain = run.then(() => {}, () => {});
  run.then(() => { s.pending -= 1; }, () => { s.pending -= 1; });
  return run;
}

/**
 * A link that opens the ledger file in Google Drive, for "Open my ledger in
 * Drive". Null until the ledger has been loaded once. Call init() first.
 */
export function fileUrl() {
  const s = slot();
  if (onDisk()) return null;
  return s.fileId ? `https://drive.google.com/file/d/${s.fileId}/view` : null;
}

/** Deletes the account's ledger file from their Drive (account deletion only). */
export async function deleteDataFile() {
  const s = slot();
  await s.writeChain;
  const fileId = s.fileId || (await findOrCreateFile());
  if (onDisk()) local.remove(fileId);
  else await getDrive().files.delete({ fileId });
  accounts.delete(s.id);
}

/** Forgets the in-memory ledger for the account in context. */
export function evictCurrentUser() {
  accounts.delete(requireContextUser().id);
}
