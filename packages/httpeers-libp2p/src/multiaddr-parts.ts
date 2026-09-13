/**
 * Reading a peer id out of a multiaddr, without `Array.prototype.findLast`.
 *
 * The prototype used `findLast`, which needs `lib: ES2023`. Raising this
 * package's lib would raise the RUNTIME floor for every consumer — the emitted
 * code calls the method regardless of what the types allow — for one line of
 * convenience. A reverse loop costs nothing and keeps the floor at ES2022,
 * matching every other package here.
 *
 * To reverse: set `"lib": ["ES2023"]` in tsconfig.json and inline
 * `.getComponents().findLast((c) => c.name === "p2p")?.value` at the two call
 * sites (`reservation.ts`, `hub-link.ts`).
 *
 * LAST, not first, and that is the whole point: a circuit address is
 * `/…/p2p/<relay>/p2p-circuit/p2p/<target>`, so the FIRST `p2p` component is
 * the relay and the last is whoever the address finally names. Taking the
 * first would hang up on the relay when asked to hang up on a peer.
 */

import type { Multiaddr } from "@multiformats/multiaddr";

export function lastPeerIdOf(addr: Multiaddr): string | undefined {
  const components = addr.getComponents();
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i];
    if (component?.name === "p2p") return component.value;
  }
  return undefined;
}
