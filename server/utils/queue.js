/**
 * Runs an async function one call at a time, queueing overlapping calls.
 *
 * For work that reads state, decides against it, then writes: two runs
 * overlapping each read the same "before" state, so both reach the same
 * decision and both write it. Serialising means the second run reads what the
 * first one wrote and decides again on current state.
 *
 * Queueing rather than rejecting, because callers pass different arguments (a
 * dry run and a real one, different date windows) and each still deserves its
 * own answer — just not at the same time.
 */
export function serialise(fn) {
  let chain = Promise.resolve();

  return (...args) => {
    // Both branches run fn: a failed run must not block the queue behind it.
    const run = chain.then(() => fn(...args), () => fn(...args));
    // The chain swallows rejections; the caller still gets the real result.
    chain = run.then(() => {}, () => {});
    return run;
  };
}
