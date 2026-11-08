import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which account the current unit of work belongs to.
 *
 * Every piece of tenant data — the Drive file, the Google client, the in-memory
 * cache — is looked up through this rather than passed around by hand. That
 * keeps the original call sites (store.read(), getAuthedClient()) unchanged while
 * making it impossible for them to reach another account's data: outside a user
 * context they throw instead of guessing.
 */
const als = new AsyncLocalStorage();

/** Runs fn with `user` ({ id, email }) as the owner of everything it touches. */
export function runAsUser(user, fn) {
  if (!user?.id) throw new Error('runAsUser needs a user with an id');
  return als.run({ user: { id: user.id, email: user.email } }, fn);
}

/** The account this code is running for, or null outside any request or job. */
export function contextUser() {
  return als.getStore()?.user || null;
}

/** Like contextUser(), but fails closed. Use wherever tenant data is touched. */
export function requireContextUser() {
  const user = contextUser();
  if (!user) throw new Error('No account in context — refusing to touch user data');
  return user;
}
