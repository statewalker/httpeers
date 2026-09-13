/**
 * Is this peer reached directly, or through the relay?
 *
 * WHY THIS EXISTS. libp2p does not upgrade a circuit to WebRTC on its own:
 * `join.ts`'s `preDialPeer` dials `<relay>/p2p-circuit/webrtc/p2p/<peer>`
 * explicitly, and the circuit's only job there is to carry the SDP exchange.
 * When that dial fails -- symmetric NAT on a mobile carrier, a VPN, no reachable
 * STUN -- `edge-dispatch.ts` SWALLOWS the failure by design and the call is
 * attempted anyway. `remote()` then dials by peer id, which resolves through the
 * peerStore to a bare `/p2p-circuit` address, and every byte crosses the relay.
 *
 * That fallback works. What it does not do is announce itself, and the silence
 * is the problem: it is 10-100x slower, it spends the relay operator's
 * bandwidth instead of going peer-to-peer, and while the relay applied a
 * per-connection data cap it truncated transfers mid-stream. The visible
 * symptom was broken images in a gallery, with one of them loading fine in a
 * fresh tab -- which reads as random corruption rather than as a transport
 * that quietly changed underneath.
 *
 * Reading the open connection's own address is the whole diagnosis, and it is
 * one call. Strings in, so this module needs no libp2p import and is testable
 * under plain Node.
 */

export type ConnectionKind = "direct" | "relayed" | "none";

/**
 * Classify the connections open to one peer, from their multiaddrs.
 *
 * `/webrtc` present means the WebRTC upgrade completed and the relay is no
 * longer in the data path. A `/p2p-circuit` WITHOUT it means it did not, and
 * traffic is being relayed. Direct wins when both are open, because that is the
 * one libp2p will actually use.
 */
export function classifyConnection(remoteAddrs: readonly string[]): ConnectionKind {
  if (remoteAddrs.length === 0) return "none";
  if (remoteAddrs.some((addr) => addr.includes("/webrtc"))) return "direct";
  if (remoteAddrs.some((addr) => addr.includes("/p2p-circuit"))) return "relayed";
  // Anything else -- a plain TCP or WebSocket address -- is a direct dial.
  return "direct";
}

/** One line a page can render unconditionally, saying what the kind means rather than naming it. */
export function describeConnection(kind: ConnectionKind): string {
  switch (kind) {
    case "direct":
      return "direct (WebRTC) — data goes peer to peer, the relay is not involved";
    case "relayed":
      return "relayed — the WebRTC upgrade did not succeed, so every byte crosses the relay: expect it to be slow";
    case "none":
      return "not connected yet";
  }
}
