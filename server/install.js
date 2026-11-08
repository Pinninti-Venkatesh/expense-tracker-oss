import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import logger from './utils/logger.js';
import * as users from './users/store.js';
import { decrypt, encrypt } from './users/secrets.js';

/**
 * The install itself, as set up in the app rather than in a config file: who
 * owns it, the Claude key the owner entered, and the invites they've sent.
 *
 * An app-password install starts with nothing configured. The first person to
 * open it claims it with a one-time setup code (printed where the app was
 * started), enters the Claude key and connects their Gmail; everyone else joins
 * through an invite link. Kept in the data folder as settings.json. Anything
 * set in the environment (ANTHROPIC_API_KEY, ALLOWED_EMAILS) still wins.
 */

const BOUND_TO = 'install'; // associated data for values encrypted here
const INVITE_DAYS = 7;

const settingsFile = () => path.join(config.dataDir, 'settings.json');
const secretsFile = () => path.join(config.dataDir, 'secrets.json');
const envKey = Boolean(config.ai.anthropic.apiKey);

let settings = null;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Reads settings.json and applies what it holds to the running config. */
export function load() {
  settings = readJson(settingsFile()) || { invites: [] };
  settings.invites ||= [];
  if (!envKey && settings.anthropicKey) {
    try {
      config.ai.anthropic.apiKey = decrypt(settings.anthropicKey, BOUND_TO);
    } catch (err) {
      logger.error('The saved Claude key could not be decrypted (was TOKEN_ENCRYPTION_KEY changed?)', err.message);
    }
  }
  return settings;
}

const current = () => settings || load();

function save(patch) {
  settings = { ...current(), ...patch };
  writeJson(settingsFile(), settings);
  return settings;
}

/* ---------- the first run ---------- */

/** Only app-password installs are set up in the app; Google sign-in is configured in .env. */
const setUpInApp = () => config.mail.access === 'app-password';

/**
 * True until someone has claimed the install. An install whose owner listed
 * the household in ALLOWED_EMAILS skips the screen: the first of them to sign
 * in becomes the owner.
 */
export async function setupNeeded() {
  if (!setUpInApp() || current().ownerId) return false;
  if (config.users.allowlist.length) return false;
  return (await users.countUsers()) === 0;
}

/** Whether the first-run screen has to ask for a Claude key. */
export const needsClaudeKey = () => config.ai.provider === 'anthropic' && !config.ai.anthropic.apiKey;

/**
 * The one-time code that proves the person setting up is the one who started
 * the app, so a fresh install on a public address can't be claimed by whoever
 * finds it first. SETUP_CODE wins (the cloud deploy script sets it so it can
 * print it); otherwise it is made once and kept until setup is done.
 */
export function setupCode() {
  if (process.env.SETUP_CODE) return String(process.env.SETUP_CODE).trim();
  const saved = readJson(secretsFile()) || {};
  if (saved.setupCode) return saved.setupCode;
  const digits = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  const code = `${digits.slice(0, 4)}-${digits.slice(4)}`;
  writeJson(secretsFile(), { ...saved, setupCode: code });
  return code;
}

const normaliseCode = (c) => String(c || '').replace(/\D/g, '');

/** Constant-time check of a typed setup code; dashes and spaces don't matter. */
export function checkSetupCode(typed) {
  const want = Buffer.from(normaliseCode(setupCode()));
  const got = Buffer.from(normaliseCode(typed));
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

function forgetSetupCode() {
  const saved = readJson(secretsFile());
  if (saved?.setupCode) {
    delete saved.setupCode;
    writeJson(secretsFile(), saved);
  }
}

/** Records the owner (and the Claude key they entered) once setup succeeds. */
export function completeSetup({ ownerId, anthropicKey }) {
  save({
    ownerId,
    setupAt: new Date().toISOString(),
    ...(anthropicKey && { anthropicKey: encrypt(anthropicKey, BOUND_TO) }),
  });
  if (anthropicKey && !envKey) config.ai.anthropic.apiKey = anthropicKey;
  forgetSetupCode();
}

/** Whether a Claude key was entered in the app (and so can be changed there). */
export const keySetInApp = () => !envKey;

export function setClaudeKey(apiKey) {
  if (envKey) throw Object.assign(new Error('The Claude key is set in this install\'s environment (ANTHROPIC_API_KEY), so it is changed there.'), { status: 409 });
  save({ anthropicKey: encrypt(apiKey, BOUND_TO) });
  config.ai.anthropic.apiKey = apiKey;
}

/** A masked hint of the key in use, for the settings screen. */
export function claudeKeyHint() {
  const key = config.ai.anthropic.apiKey;
  return key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null;
}

/* ---------- the owner ---------- */

/**
 * The owner's account id. Installs from before owners existed (or set up via
 * ALLOWED_EMAILS) make their earliest account the owner the first time it's asked.
 */
export async function ownerId() {
  if (current().ownerId) return current().ownerId;
  if (!setUpInApp()) return null;
  const all = (await users.listUsers()).filter((u) => u.status === 'active');
  if (!all.length) return null;
  // Records without a date sort last, so they never outrank a dated first account.
  const when = (u) => Date.parse(u.createdAt || '') || Infinity;
  const first = all.sort((a, b) => when(a) - when(b))[0];
  save({ ownerId: first.id });
  return first.id;
}

export const isOwner = async (accountId) => Boolean(accountId) && (await ownerId()) === accountId;

/* ---------- invites ---------- */

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const liveInvites = (now = Date.now()) => current().invites.filter((i) => !i.usedAt && Date.parse(i.expiresAt) > now);

/** A one-time link for someone to join. Only the token's hash is kept. */
export function createInvite(createdBy) {
  const token = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  const invite = {
    id: crypto.randomBytes(6).toString('hex'),
    tokenHash: hashToken(token),
    createdBy,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_DAYS * 24 * 3600_000).toISOString(),
  };
  // Used and expired invites are dropped as new ones are made.
  save({ invites: [...liveInvites(now), invite] });
  return { id: invite.id, token, expiresAt: invite.expiresAt };
}

export const listInvites = () => liveInvites().map(({ id, createdAt, expiresAt }) => ({ id, createdAt, expiresAt }));

export function cancelInvite(id) {
  save({ invites: current().invites.filter((i) => i.id !== id) });
}

/** The unused, unexpired invite this token belongs to, or null. */
export function findInvite(token) {
  if (!token) return null;
  const hash = hashToken(token);
  return liveInvites().find((i) => i.tokenHash === hash) || null;
}

export function useInvite(id, accountId) {
  save({
    invites: current().invites.map((i) => (i.id === id ? { ...i, usedAt: new Date().toISOString(), usedBy: accountId } : i)),
  });
}
