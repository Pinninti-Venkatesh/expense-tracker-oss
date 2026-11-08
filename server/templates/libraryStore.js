import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

/**
 * Where the shared template library lives: Firestore in production, a JSON
 * file in development, beside the account registry. Records are keyed by form
 * hash and hold no personal data (see library.js).
 *
 * update(key, change) runs change(record | null) and saves what it returns,
 * atomically: a Firestore transaction, or a serial queue for the file. Returning
 * null writes nothing.
 */

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
    update: (key, change) => serially(() => {
      const all = load();
      const next = change(all[key] || null);
      if (next) {
        all[key] = next;
        save(all);
      }
      return next;
    }),
    listPublished: async () => Object.values(load()).filter((r) => r.status === 'published'),
  };
}

function firestoreBackend(collection) {
  let col = null;
  let db = null;
  const ready = async () => {
    if (!col) {
      const { Firestore } = await import('@google-cloud/firestore');
      db = new Firestore({ ignoreUndefinedProperties: true });
      col = db.collection(collection);
    }
    return col;
  };

  return {
    update: async (key, change) => {
      const ref = (await ready()).doc(key);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const next = change(snap.exists ? snap.data() : null);
        if (next) tx.set(ref, next);
        return next;
      });
    },
    listPublished: async () => (await (await ready()).where('status', '==', 'published').get()).docs.map((d) => d.data()),
  };
}

/** An in-memory library, for tests. */
export function memoryBackend() {
  const all = new Map();
  return {
    records: all,
    update: async (key, change) => {
      const next = change(all.get(key) || null);
      if (next) all.set(key, structuredClone(next));
      return next;
    },
    listPublished: async () => [...all.values()].filter((r) => r.status === 'published'),
  };
}

let backend = null;
let override = null;

export function libraryBackend() {
  if (override) return override;
  backend ||= config.users.backend === 'firestore'
    ? firestoreBackend(config.library.collection)
    : fileBackend(config.library.filePath);
  return backend;
}

/** Tests swap the store for memoryBackend(). Never used by the app itself. */
export function __setLibraryBackendForTests(store) {
  override = store;
}
