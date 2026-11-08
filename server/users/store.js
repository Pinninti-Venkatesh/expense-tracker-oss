import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import logger from '../utils/logger.js';
import { hasMailAccess } from '../auth/mail-access.js';

/**
 * The account registry — the only thing this server keeps about a person.
 *
 * Deliberately small: Google account id, email, name, the encrypted refresh
 * token, consent and bookkeeping timestamps. Transactions never land here; they
 * live in a file the app created in the user's own Google Drive.
 *
 * Two backends behind one interface. Firestore in production, because Cloud Run
 * has no durable disk. A JSON file for local development, so the app runs without
 * a Google Cloud project.
 */

// Every API request resolves its session to a record, and the frontend refetches
// once a minute. A short cache keeps that from becoming a Firestore read per tick.
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // id -> { record, at }

function fileBackend(filePath) {
  let chain = Promise.resolve();
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  };
  const save = (all) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  };
  const serially = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  return {
    get: async (id) => load()[id] || null,
    merge: (id, patch) => serially(() => {
      const all = load();
      all[id] = { ...(all[id] || {}), ...patch, id };
      save(all);
      return all[id];
    }),
    list: async () => Object.values(load()),
    remove: (id) => serially(() => {
      const all = load();
      delete all[id];
      save(all);
    }),
  };
}

async function firestoreBackend(collection) {
  const { Firestore } = await import('@google-cloud/firestore');
  const col = new Firestore({ ignoreUndefinedProperties: true }).collection(collection);

  return {
    get: async (id) => {
      const snap = await col.doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    merge: async (id, patch) => {
      await col.doc(id).set({ ...patch, id }, { merge: true });
      return (await col.doc(id).get()).data();
    },
    list: async () => (await col.get()).docs.map((d) => d.data()),
    remove: async (id) => {
      await col.doc(id).delete();
    },
  };
}

let backendPromise = null;
function backend() {
  backendPromise ||= config.users.backend === 'firestore'
    ? firestoreBackend(config.users.collection)
    : Promise.resolve(fileBackend(config.users.filePath));
  return backendPromise;
}

export async function getUser(id) {
  if (!id) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.record;
  const record = await (await backend()).get(id);
  cache.set(id, { record, at: Date.now() });
  return record;
}

export async function saveUser(id, patch) {
  const record = await (await backend()).merge(id, { ...patch, updatedAt: new Date().toISOString() });
  cache.set(id, { record, at: Date.now() });
  return record;
}

/** Accounts the scheduled poll should run for. */
export async function listPollableUsers() {
  const all = await (await backend()).list();
  return all.filter((u) => u.status === 'active' && hasMailAccess(u) && !u.needsReauth);
}

/** Drops cached records, after the accounts file was replaced (a restore). */
export function forgetCache() {
  cache.clear();
}

export async function listUsers() {
  return (await backend()).list();
}

export async function countUsers() {
  return (await (await backend()).list()).length;
}

export async function deleteUser(id) {
  await (await backend()).remove(id);
  cache.delete(id);
  logger.info(`Deleted account record ${id}`);
}
