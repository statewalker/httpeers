import type { Libp2p } from "@libp2p/interface";

/** How a member reaches the hub now. */
export type MemberLink = "direct" | "relay" | null;

/**
 * How a member reaches the hub right now, from the hub's own open connections
 * to it: any unlimited one (WebRTC) is `direct`; only limited ones (a relay
 * circuit) is `relay`; none is `null`. A member's advertised addresses cannot
 * answer this -- a relay-fallback member advertises none.
 *
 * Filters `getConnections()` by remote peer rather than parsing the id into a
 * `PeerId`: the same answer, without a dependency on `@libp2p/peer-id`.
 */
export function linkOf(node: Pick<Libp2p, "getConnections">, peerId: string): MemberLink {
  const open = node
    .getConnections()
    .filter((c) => c.status === "open" && c.remotePeer.toString() === peerId);
  if (open.length === 0) return null;
  return open.some((c) => c.limits == null) ? "direct" : "relay";
}
