/**
 * A member's link to its hub: reach it, reserve on it, and address other
 * members through it. See `./hub-relay.ts` for the hub's side and why.
 *
 * TRANSPORT-NEUTRAL, like `./reservation.ts`: nothing here is browser-only,
 * so the same code runs in a page and under the Node tests.
 */
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { lastPeerIdOf } from "./multiaddr-parts.js";
import type { Libp2p } from "@libp2p/interface";
import { type RelaySupervisor, superviseRelay } from "./reservation.js";

/**
 * The address a member dials another member at: through their hub, with a
 * WebRTC upgrade. The `/webrtc` step is what turns the hub's circuit into a
 * signalling channel -- dialled without it, the result is a limited
 * connection through the hub, which carries nothing.
 *
 * COMPOSED, NEVER TAKEN FROM A PEER'S OWN ADDRESSES. A reservation on the
 * hub makes libp2p report a double-circuit address
 * (`<relay>/p2p-circuit/webrtc/p2p/<hub>/p2p-circuit/p2p/<member>`) that
 * nothing can dial. This works because the circuit transport reuses the
 * connection it already holds to the hub.
 */
export function hubRoute(hubPeerId: string, peerId: string): string {
  return `/p2p/${hubPeerId}/p2p-circuit/webrtc/p2p/${peerId}`;
}

/**
 * Reach the hub over WebRTC through the public relay, and keep ONLY the
 * WebRTC connection.
 *
 * WHY THE SIGNALLING CIRCUIT IS CLOSED. Reaching the hub leaves two
 * connections to it: the limited circuit through the public relay that
 * carried the SDP exchange, and the WebRTC one. The circuit transport relays
 * through `getConnections(relay)[0]` -- the FIRST connection to the relay,
 * limited or not -- so while the limited one is open, every dial THROUGH the
 * hub fails with `LimitedConnectionError`. Found by the `proto/hub-relay`
 * prototype; the "connects two members directly" test fails without it.
 */
export async function reachHub(node: Libp2p, relayAddr: string, hubPeerId: string): Promise<void> {
  await node.dial(multiaddr(`${relayAddr}/p2p-circuit/webrtc/p2p/${hubPeerId}`));
  const limited = node.getConnections(peerIdFromString(hubPeerId)).filter((c) => c.limits != null);
  await Promise.all(limited.map((c) => c.close()));
}

/**
 * Reserve on the hub, over the WebRTC connection `reachHub` left open.
 * Returns the reserved address. Only a member is granted one -- call this
 * after the hub has accepted this peer, not before.
 *
 * A CONFIGURED RELAY, NOT A DISCOVERED ONE: libp2p will not restore it on
 * its own if the link to the hub drops, which is `superviseHubReservation`'s
 * job, below. Each call adds a listener; after a lost link the
 * old one sits empty. That is one small object per reconnection, accepted
 * rather than reaching into libp2p's internals to reuse it.
 */
export async function reserveOnHub(node: Libp2p, hubPeerId: string): Promise<string> {
  try {
    await transportManagerOf(node).listen([multiaddr(`/p2p/${hubPeerId}/p2p-circuit`)]);
  } catch (err) {
    // libp2p reports a refused reservation as "Some configured addresses
    // failed to be listened on", which names neither the hub nor the reason.
    throw new Error(
      `hub-link: the hub (${hubPeerId}) did not grant a reservation. A hub grants one only to ` +
        "its members (PERMISSION_DENIED: this peer is not one, or not yet), and only if it " +
        `relays at all (UnsupportedProtocolError: it does not). Cause: ${String(err)}`,
      { cause: err },
    );
  }
  const reserved = node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .find((addr) => addr.includes(`/p2p/${hubPeerId}/p2p-circuit`));
  if (reserved == null) {
    throw new Error(`hub-link: listening on the hub (${hubPeerId}) produced no reserved address`);
  }
  return reserved;
}

/**
 * Close this member's connection to the public relay, once its hub link is
 * up. A member holds no reservation there any more, and other members reach
 * it through the hub, so the socket would only spend the relay's capacity.
 * It is reopened on demand: `reachHub` dials through the relay whenever the
 * hub has to be reached again.
 */
export async function leaveRelay(node: Libp2p, relayAddr: string): Promise<void> {
  const relayPeerId = lastPeerIdOf(multiaddr(relayAddr));
  if (relayPeerId != null) await node.hangUp(peerIdFromString(relayPeerId));
}

export interface SuperviseHubReservationInit {
  node: Libp2p;
  /** The public relay the hub is reached through -- `reachHub`'s. */
  relayAddr: string;
  hubPeerId: string;
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Keep this member's reservation on its hub: whenever it is lost, reach the
 * hub again and re-reserve, with `superviseRelay`'s backoff and `poke()`.
 * Call once the first `reserveOnHub` has succeeded.
 */
export function superviseHubReservation(init: SuperviseHubReservationInit): RelaySupervisor {
  const { node, relayAddr, hubPeerId } = init;
  return superviseRelay({
    node,
    relayAddr: `/p2p/${hubPeerId}`,
    minRetryDelayMs: init.minRetryDelayMs,
    maxRetryDelayMs: init.maxRetryDelayMs,
    restore: async () => {
      await reachHub(node, relayAddr, hubPeerId);
      await reserveOnHub(node, hubPeerId);
    },
  });
}

/**
 * The node's transport manager -- the only way to add a listen address after
 * start. `components` is a public field of the libp2p 3.x node class but not
 * part of the `Libp2p` interface, hence the narrow cast; pinned by
 * `tests/e2e/hub-relay.test.ts`, which fails if a libp2p upgrade moves it.
 */
function transportManagerOf(node: Libp2p): {
  listen(addrs: ReturnType<typeof multiaddr>[]): Promise<void>;
} {
  return (
    node as unknown as {
      components: { transportManager: { listen(addrs: unknown[]): Promise<void> } };
    }
  ).components.transportManager;
}
