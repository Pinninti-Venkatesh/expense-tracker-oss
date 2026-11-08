import * as users from '../users/store.js';
import { decrypt, encrypt } from '../users/secrets.js';

/**
 * Statement passwords a person chose to have remembered, so new statements are
 * read on every poll without asking. One per bank (keyed by the sender address),
 * encrypted with the install's key and bound to the account, kept on the
 * account record. Nobody else in the household can use or see them.
 */

export async function savedPasswords(accountId) {
  const user = await users.getUser(accountId);
  if (!user?.encryptedStatementPasswords) return {};
  try {
    return JSON.parse(decrypt(user.encryptedStatementPasswords, accountId));
  } catch {
    return {};
  }
}

export async function rememberPasswords(accountId, passwords) {
  const merged = { ...(await savedPasswords(accountId)), ...passwords };
  await users.saveUser(accountId, { encryptedStatementPasswords: encrypt(JSON.stringify(merged), accountId) });
  return Object.keys(merged);
}

export async function forgetPasswords(accountId) {
  await users.saveUser(accountId, { encryptedStatementPasswords: null });
}
