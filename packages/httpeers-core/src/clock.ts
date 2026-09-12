/**
 * A monotonically strictly-increasing millisecond clock, backed by
 * `Date.now()`.
 *
 * `Date.now()` alone cannot ORDER two events a caller knows happened one
 * after another — its millisecond resolution means two calls made
 * microseconds apart, on either side of a real `await`, can return the
 * SAME integer. `revocation.ts`'s `check` compares a token's `iat` against
 * a `ChangeEntry.changedAt` to decide whether the token was minted before
 * or after a revocation; on a tie it cannot tell which happened first, and
 * silently resolves it as "minted after" — the token is honoured, even
 * when the hub's own call order (mint the token, THEN independently revoke
 * that peer, each awaited in turn) proves the revocation came second. This
 * is not a rare pathological case: `mintToken`'s round trip and
 * `RevocationRegistry.changeRoles`'s registration are ordinary async work,
 * and their real elapsed time can be well under a millisecond.
 *
 * `createMonotonicClock` closes that gap the way a Lamport clock does: each
 * call returns `max(Date.now(), lastReturned + 1)`. Two calls through the
 * SAME clock instance are therefore always strictly ordered, regardless of
 * how close together in real time they land — not merely unlikely to tie,
 * but unable to.
 *
 * This only orders calls against THIS instance — it is not a substitute for
 * wall-clock time across processes (`revocation.ts`'s "no clock
 * synchronisation" invariant still holds for cross-peer comparisons: a
 * provider must never compare a hub-issued timestamp against its own
 * clock). A hub that wants its own `iat` and `changedAt` values to be
 * mutually orderable must mint tokens and record revocations through the
 * SAME clock instance — see `mesh.ts`'s `buildTestHub` and `main.ts`'s
 * `startHub` for the wiring.
 */
export function createMonotonicClock(base: () => number = Date.now): () => number {
  let last = 0;
  return () => {
    const t = base();
    last = t > last ? t : last + 1;
    return last;
  };
}
