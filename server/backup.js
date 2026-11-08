import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import config from './config.js';

/**
 * A whole app-password install in one file: accounts, every ledger, settings
 * made in the app, and the secrets that decrypt them. It is how an install is
 * kept safe (its ledgers live on one machine) and how it moves to another host.
 *
 * The file holds every member's encrypted app password together with the key
 * that decrypts it, so it is itself encrypted with a passphrase the owner
 * chooses: scrypt for the key, AES-256-GCM for the contents. Without the
 * passphrase it is noise; with a wrong one, restoring fails cleanly.
 */

const scrypt = promisify(crypto.scrypt);
const FORMAT = 'expenses-backup';
const VERSION = 1;
// scrypt cost: ~100ms on a laptop, so guessing passphrases offline is slow.
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSPHRASE = 8;

const SECRET_KEYS = ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'CRON_SECRET'];

const deriveKey = (passphrase, salt) => scrypt(String(passphrase).normalize('NFC'), salt, 32, KDF);

function readIfThere(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Everything the install keeps, as { relative path: file contents }. */
function collect() {
  const files = {};
  const add = (rel, abs) => {
    const text = readIfThere(abs);
    if (text !== null) files[rel] = text;
  };
  add('users.json', config.users.filePath);
  add('settings.json', path.join(config.dataDir, 'settings.json'));
  add('template-library.json', config.library.filePath);
  for (const name of fs.existsSync(config.ledger.dir) ? fs.readdirSync(config.ledger.dir) : []) {
    if (name.endsWith('.json')) add(`ledgers/${name}`, path.join(config.ledger.dir, name));
  }
  return files;
}

/** Makes the encrypted backup file's contents. */
export async function createBackup(passphrase) {
  if (String(passphrase || '').length < MIN_PASSPHRASE) {
    throw Object.assign(new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`), { status: 400 });
  }
  const payload = {
    createdAt: new Date().toISOString(),
    product: config.product.name,
    // The secrets in use, whether made by the install or set in its environment:
    // without the encryption key, the app passwords in users.json can't be read.
    secrets: {
      SESSION_SECRET: config.session.secret,
      TOKEN_ENCRYPTION_KEY: config.security.tokenEncryptionKey,
      CRON_SECRET: config.cron.secret,
    },
    files: collect(),
  };
  return {
    filename: `expenses-backup-${payload.createdAt.slice(0, 10)}.json`,
    content: await sealBackup(payload, passphrase),
    summary: { accounts: Object.keys(JSON.parse(payload.files['users.json'] || '{}')).length, ledgers: Object.keys(payload.files).filter((f) => f.startsWith('ledgers/')).length },
  };
}

/** Encrypts a backup's contents with a passphrase, as the file's text. */
export async function sealBackup(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(`${FORMAT}/${VERSION}`));
  const body = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(payload))), cipher.final()]);
  const file = {
    format: FORMAT,
    version: VERSION,
    note: `An encrypted backup of ${config.product.name}. Restore it on a new install's first screen, with its passphrase.`,
    kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  };
  return JSON.stringify(file);
}

const notABackup = () => Object.assign(new Error("That file isn't a backup from this app."), { status: 400, field: 'file' });

/** Decrypts a backup file's contents. Throws a plain-words error for a wrong passphrase. */
export async function openBackup(content, passphrase) {
  let file;
  try {
    file = JSON.parse(String(content));
  } catch {
    throw notABackup();
  }
  if (file?.format !== FORMAT || !file.kdf?.salt || !file.iv || !file.tag || !file.data) throw notABackup();
  if (file.version > VERSION) {
    throw Object.assign(new Error('This backup is from a newer version of the app. Update this one first.'), { status: 400, field: 'file' });
  }
  try {
    const key = await deriveKey(passphrase, Buffer.from(file.kdf.salt, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${FORMAT}/${file.version}`));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
    return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  } catch {
    throw Object.assign(new Error("That passphrase doesn't open this backup."), { status: 400, field: 'passphrase' });
  }
}

const writePrivate = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/**
 * Puts a decrypted backup in place on a fresh install, and switches the running
 * server to its secrets, so everyone's saved access works straight away.
 */
export function restoreBackup(payload) {
  const secrets = payload?.secrets || {};
  if (!SECRET_KEYS.every((k) => typeof secrets[k] === 'string' && secrets[k])) throw notABackup();

  // A key set in this install's environment wins over the data folder. For the
  // encryption key that would leave every saved password unreadable, so it must
  // match; the others (sessions, the scheduled-check key) may simply differ.
  const envKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (envKey && envKey !== secrets.TOKEN_ENCRYPTION_KEY) {
    throw Object.assign(new Error("This install sets TOKEN_ENCRYPTION_KEY in its environment, which differs from the backup's, so it couldn't read the saved passwords. Remove it there (the data folder keeps it), then restore again."), { status: 409 });
  }

  const files = payload.files || {};
  for (const [rel, text] of Object.entries(files)) {
    // Only the places a backup writes, never a path that climbs out of the folder.
    const ledger = /^ledgers\/[\w.-]+\.json$/.test(rel);
    const target = rel === 'users.json' ? config.users.filePath
      : rel === 'settings.json' ? path.join(config.dataDir, 'settings.json')
        : rel === 'template-library.json' ? config.library.filePath
          : ledger ? path.join(config.ledger.dir, path.basename(rel))
            : null;
    if (target && typeof text === 'string') writePrivate(target, text);
  }

  const secretsFile = path.join(config.dataDir, 'secrets.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  } catch {
    // none yet
  }
  delete current.setupCode;
  writePrivate(secretsFile, JSON.stringify({ ...current, ...Object.fromEntries(SECRET_KEYS.map((k) => [k, secrets[k]])) }, null, 2));

  // Read at call time everywhere, so this takes effect without a restart.
  // Values set in the environment still win, as they will after a restart.
  config.session.secret = process.env.SESSION_SECRET || secrets.SESSION_SECRET;
  config.security.tokenEncryptionKey = secrets.TOKEN_ENCRYPTION_KEY;
  config.cron.secret = process.env.CRON_SECRET || secrets.CRON_SECRET;

  return {
    accounts: Object.keys(JSON.parse(files['users.json'] || '{}')).length,
    ledgers: Object.keys(files).filter((f) => f.startsWith('ledgers/')).length,
    createdAt: payload.createdAt || null,
  };
}
