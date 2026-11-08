import * as users from '../users/store.js';

/**
 * Read-change-write on one account's billing record, one change at a time.
 *
 * The checkout confirmation from the browser and Razorpay's webhooks for the
 * same subscription often arrive together. Each reads the record, decides, and
 * writes; overlapping, the second would overwrite the first. Changes for
 * different accounts never wait on each other.
 *
 * In memory, which is enough while the service runs as a single instance (see
 * docs/self-hosting.md, --max-instances=1). A second instance needs a Firestore transaction.
 */
const chains = new Map(); // account id -> tail of that account's queue

/**
 * change(billing, account) returns the new billing record, or the same object
 * to write nothing. It may be async and may throw; a throw writes nothing and
 * reaches the caller. Resolves to the saved account, or null if there is none.
 */
export function updateBilling(accountId, change) {
  const previous = chains.get(accountId) || Promise.resolve();
  const run = previous.then(async () => {
    const account = await users.getUser(accountId);
    if (!account) return null;
    const current = account.billing || {};
    const next = await change(current, account);
    if (!next || next === current) return account;
    return users.saveUser(accountId, { billing: next });
  });
  const tail = run.then(() => {}, () => {});
  chains.set(accountId, tail);
  tail.then(() => {
    if (chains.get(accountId) === tail) chains.delete(accountId);
  });
  return run;
}
