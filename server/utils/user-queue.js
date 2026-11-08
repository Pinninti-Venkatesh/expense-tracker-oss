import { requireContextUser } from '../context.js';

/**
 * serialise() from queue.js, but with one queue per account.
 *
 * Two imports for the same user must not overlap — each snapshots what is
 * already recorded, so both would insert the same rows. Different users must
 * never wait on each other, which a single global queue would force.
 */
export function serialisePerUser(fn) {
  const chains = new Map(); // account id -> tail of that account's queue

  return (...args) => {
    const { id } = requireContextUser();
    const previous = chains.get(id) || Promise.resolve();
    // Both branches run fn: a failed run must not block the queue behind it.
    const run = previous.then(() => fn(...args), () => fn(...args));
    const tail = run.then(() => {}, () => {});
    chains.set(id, tail);
    tail.then(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return run;
  };
}
