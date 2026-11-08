import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { contextUser, requireContextUser } from '../context.js';
import * as users from '../users/store.js';
import { decrypt, encrypt } from '../users/secrets.js';

const { clientId, clientSecret, redirectUri } = config.google;

/**
 * gmail.readonly can read mail but never modify, send or delete it. drive.file
 * reaches only files this app itself created, not the rest of the user's Drive.
 * Nothing broader is requested: every extra scope is one more thing Google's
 * verification has to approve and one more thing a user has to trust.
 */
export const DATA_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.file',
];
const IDENTITY_SCOPES = ['openid', 'email', 'profile'];

const newClient = () => new google.auth.OAuth2(clientId, clientSecret, redirectUri);

/**
 * One consent covers both who you are and what the app may read. `forceConsent`
 * shows Google's consent screen even when access was granted before — the only
 * way to be handed a fresh refresh token.
 */
export function getAuthUrl({ state, forceConsent = false }) {
  return newClient().generateAuthUrl({
    access_type: 'offline',
    include_granted_scopes: true,
    scope: [...IDENTITY_SCOPES, ...DATA_SCOPES],
    state,
    prompt: forceConsent ? 'consent select_account' : 'select_account',
  });
}

/** Exchanges the callback code and verifies the identity token it came with. */
export async function exchangeCode(code) {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error('Google did not return an identity token');

  // Verifying proves Google issued the token for THIS client. Never trust the
  // email without it.
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
  const p = ticket.getPayload();
  return { tokens, profile: { sub: p.sub, email: p.email, emailVerified: p.email_verified, name: p.name } };
}

/** Google's consent screen lets people untick scopes; the app is useless without both. */
export function hasRequiredScopes(tokens) {
  const granted = new Set(String(tokens.scope || '').split(/\s+/));
  return DATA_SCOPES.every((s) => granted.has(s));
}

// Account id -> { client, tokenCipher }. The cipher is kept to notice when the
// stored token changed underneath (a reconnect) and the cached client is stale.
const clients = new Map();

/**
 * Makes an OAuth client for this account available to getAuthedClient().
 * Called once per request and per scheduled poll, before any Google call.
 */
export async function prepareClient(user) {
  if (!user?.encryptedRefreshToken) return null;
  const cached = clients.get(user.id);
  if (cached && cached.tokenCipher === user.encryptedRefreshToken) return cached.client;

  const client = newClient();
  client.setCredentials({ refresh_token: decrypt(user.encryptedRefreshToken, user.id) });

  // Google occasionally rotates refresh tokens. Persist the new one straight
  // away, or the next cold start would reload a dead token.
  client.on('tokens', (tokens) => {
    if (!tokens.refresh_token) return;
    const cipher = encrypt(tokens.refresh_token, user.id);
    const entry = clients.get(user.id);
    if (entry) entry.tokenCipher = cipher;
    users.saveUser(user.id, { encryptedRefreshToken: cipher })
      .catch((err) => logger.error(`Could not store rotated token for ${user.id}`, err.message));
  });

  clients.set(user.id, { client, tokenCipher: user.encryptedRefreshToken });
  return client;
}

export function forgetClient(userId) {
  clients.delete(userId);
}

/** The Google client for the account in context. Throws outside one. */
export function getAuthedClient() {
  const user = requireContextUser();
  const entry = clients.get(user.id);
  if (!entry) throw new Error('Not authenticated with Google — sign in again');
  return entry.client;
}

export function isAuthenticated() {
  const user = contextUser();
  return Boolean(user && clients.has(user.id));
}

/** Revokes the app's access at Google. Best effort: the token may already be dead. */
export async function revokeAccess(user) {
  if (user?.encryptedRefreshToken) {
    try {
      await newClient().revokeToken(decrypt(user.encryptedRefreshToken, user.id));
    } catch (err) {
      logger.warn(`Token revoke failed for ${user.id} (may already be revoked)`, err.message);
    }
  }
  forgetClient(user?.id);
}
