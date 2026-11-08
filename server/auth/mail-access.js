import config from '../config.js';
import { prepareClient, revokeAccess, forgetClient, isAuthenticated } from './google-auth.js';
import * as imap from '../gmail/imap.js';
import { decrypt } from '../users/secrets.js';

/**
 * The two ways an account reaches its Gmail (config.mail.access), behind one
 * set of calls, so sign-in checks, the scheduled poll and error handling never
 * need to know which is in use.
 *
 *   google        an encrypted OAuth refresh token (encryptedRefreshToken)
 *   app-password  an encrypted Gmail app password (encryptedAppPassword)
 */

const usesAppPassword = () => config.mail.access === 'app-password';

/** Whether the account holds working credentials for the install's access type. */
export function hasMailAccess(user) {
  if (!user) return false;
  return Boolean(usesAppPassword() ? user.encryptedAppPassword : user.encryptedRefreshToken);
}

/** Readies the account's mail access before anything reads its email. */
export async function prepareMail(user) {
  if (!hasMailAccess(user)) return;
  if (usesAppPassword()) imap.prepare(user, decrypt(user.encryptedAppPassword, user.id));
  else await prepareClient(user);
}

/** Whether the account in context is ready to read mail (prepareMail ran). */
export function isMailReady() {
  return usesAppPassword() ? imap.isPrepared() : isAuthenticated();
}

/** Drops cached access for an account, e.g. after its credentials change. */
export function forgetMail(userId) {
  forgetClient(userId);
  imap.forget(userId);
}

/**
 * Ends the app's access. A Google token is revoked at Google; an app password
 * can only be removed by its owner in their Google account, which the account
 * deletion screen tells them.
 */
export async function revokeMail(user) {
  if (usesAppPassword()) forgetMail(user?.id);
  else await revokeAccess(user);
}

/** True when an error means the person must sign in again, not that a call failed. */
export function isAccessRevoked(errOrMessage) {
  const text = typeof errOrMessage === 'string' ? errOrMessage : errOrMessage?.message || '';
  return new RegExp(`invalid_grant|${imap.APP_PASSWORD_REJECTED}`, 'i').test(text);
}
