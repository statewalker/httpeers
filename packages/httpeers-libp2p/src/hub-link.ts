/**
 * A member's link to its hub: reach it, reserve on it, and address other
 * members through it. See `./hub-relay.ts` for the hub's side and why.
 *
 * TRANSPORT-NEUTRAL, like `./reservation.ts`: nothing here is browser-only,
 * so the same code runs in a page and under the Node tests.
 */

import type { Connection, Libp2p } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { lastPeerIdOf } from "./multiaddr-parts.js";
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
 * Reach the hub through the public relay WITHOUT the WebRTC upgrade, and KEEP
 * the circuit: the fallback for when `reachHub` cannot work (a hub in Docker on
 * a bridge network has nothing a WebRTC dial can reach).
 *
 * The result is a LIMITED connection, and nothing crosses it unless both ends
 * opt in: the hub serves with `serveOnLimitedConnection: true`, and the member
 * calls with `callOnLimitedConnection` allowing the hub (`servePeer`,
 * `createRemote`), which then opens its streams on this connection rather than
 * dialling again.
 *
 * RETURNED AS LIBP2P RETURNS IT, and not always limited: if an unlimited
 * connection to the hub already exists (a WebRTC upgrade that did come up),
 * `dial` hands that back instead of opening a circuit. Check `limits` if it
 * matters; the intended caller only gets here after `reachHub` failed.
 *
 * NOT CLOSED, unlike `reachHub`'s circuit, because it is the data path. Two
 * consequences for the caller: `reserveOnHub` has nothing to reserve over, so
 * other members cannot reach this one; and `leaveRelay` would hang up the
 * circuit itself.
 */
export async function reachHubRelayed(
  node: Libp2p,
  relayAddr: string,
  hubPeerId: string,
): Promise<Connection> {
  return node.dial(multiaddr(`${relayAddr}/p2p-circuit/p2p/${hubPeerId}`));
}

/**
 * Why a hub did not grant a reservation, as far as libp2p lets us tell.
 *
 *   - `"store-full"` -- `RESERVATION_REFUSED`: the hub's relay already holds
 *     as many reservations as it grants (libp2p's `maxReservations`). A
 *     capacity condition on the hub; nothing about this peer.
 *   - `"resource-limit"` -- `RESOURCE_LIMIT_EXCEEDED`: the same kind of thing,
 *     from a relay that meters resources rather than counting reservations.
 *   - `"not-a-member"` -- `PERMISSION_DENIED`: the hub's `membershipGater`
 *     does not count this peer as a member. (libp2p also answers it to a
 *     reservation asked for over a relayed connection, which `reserveOnHub`
 *     never does: it runs over `reachHub`'s WebRTC connection.)
 *   - `"no-relay"` -- the hub does not speak the relay protocol at all
 *     (`UnsupportedProtocolError`): a hub deployed without `hubRelayService`.
 *   - `"no-answer"` -- no status came back: a timeout, a link that dropped
 *     mid-request. Nothing was refused; nothing was granted either.
 *   - `"other"` -- any other status, named verbatim in the message.
 */
export type HubReservationRefusal =
  | "store-full"
  | "resource-limit"
  | "not-a-member"
  | "no-relay"
  | "no-answer"
  | "other";

/** `reserveOnHub`'s failure: which refusal, the relay's own status when it sent one, and libp2p's error as `cause`. */
export class HubReservationError extends Error {
  constructor(
    readonly hubPeerId: string,
    /** The circuit-relay v2 status the hub answered (`"RESERVATION_REFUSED"`, ...), or `null` when it answered none. */
    readonly status: string | null,
    readonly refusal: HubReservationRefusal,
    options: { cause: unknown },
  ) {
    super(describeRefusal(hubPeerId, status, refusal, options.cause), options);
    this.name = "HubReservationError";
  }
}

/**
 * Read the refusal out of libp2p's error.
 *
 * FROM THE TEXT, BECAUSE THAT IS ALL THERE IS. The transport manager wraps
 * every failed listen in one `UnsupportedListenAddressesError` whose message
 * embeds the inner error's stack -- `reservation failed with status <STATUS>`
 * from the reservation store, or `UnsupportedProtocolError: ...` from protocol
 * negotiation -- and keeps no reference to the inner error itself. The
 * patterns are pinned against a real hub by the conformance suite's
 * `member-reservation-fallback.test.ts`.
 */
function classify(err: unknown): { status: string | null; refusal: HubReservationRefusal } {
  const text =
    err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
  const status = /reservation failed with status (\w+)/.exec(text)?.[1] ?? null;
  switch (status) {
    case "RESERVATION_REFUSED":
      return { status, refusal: "store-full" };
    case "RESOURCE_LIMIT_EXCEEDED":
      return { status, refusal: "resource-limit" };
    case "PERMISSION_DENIED":
      return { status, refusal: "not-a-member" };
    case null:
      return {
        status,
        refusal: /UnsupportedProtocolError|could not negotiate/.test(text)
          ? "no-relay"
          : "no-answer",
      };
    default:
      return { status, refusal: "other" };
  }
}

function describeRefusal(
  hubPeerId: string,
  status: string | null,
  refusal: HubReservationRefusal,
  cause: unknown,
): string {
  const hub = `hub-link: the hub (${hubPeerId})`;
  switch (refusal) {
    case "store-full":
      return (
        `${hub} refused a reservation with RESERVATION_REFUSED: the hub's reservation store is ` +
        "full (it grants a fixed number, each held until it expires). Nothing is wrong with this " +
        "peer; the hub has no slot for it."
      );
    case "resource-limit":
      return `${hub} refused a reservation with RESOURCE_LIMIT_EXCEEDED: the hub's relay is at a resource limit.`;
    case "not-a-member":
      return (
        `${hub} refused a reservation with PERMISSION_DENIED: this peer is not a member as far ` +
        "as the hub is concerned (a hub grants reservations to its members only)."
      );
    case "no-relay":
      return `${hub} does not relay at all -- it has no circuit-relay service (UnsupportedProtocolError).`;
    case "no-answer":
      return `${hub} gave no answer to a reservation request. Cause: ${firstLine(cause)}`;
    case "other":
      return `${hub} refused a reservation with ${status}.`;
  }
}

/** The inner error libp2p quotes, or the error itself -- without the stack. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text.split("\n").map((line) => line.trim());
  // libp2p's wrapper: a header line, then `<addr>: <inner error>` per address.
  const inner = lines.find((line) => line.startsWith("/") && line.includes(": "));
  return inner != null ? inner.slice(inner.indexOf(": ") + 2) : (lines[0] ?? "");
}

/**
 * Reserve on the hub, over the WebRTC connection `reachHub` left open.
 * Returns the reserved address. Only a member is granted one -- call this
 * after the hub has accepted this peer, not before.
 *
 * A REFUSAL IS A `HubReservationError` that names the relay's own status --
 * see `HubReservationRefusal`. libp2p reports every refusal alike, as "Some
 * configured addresses failed to be listened on"; a full store and a
 * non-member used to read the same, and in production a full store was
 * diagnosed as a membership problem.
 *
 * A CONFIGURED RELAY, NOT A DISCOVERED ONE: libp2p will not restore it on
 * its own if the link to the hub drops, which is `superviseHubReservation`'s
 * job, below. Each call adds a listener; after a lost link -- or a refused
 * reservation -- the old one sits empty. That is one small object per
 * attempt, accepted rather than reaching into libp2p's internals to reuse it.
 */
export async function reserveOnHub(node: Libp2p, hubPeerId: string): Promise<string> {
  try {
    await transportManagerOf(node).listen([multiaddr(`/p2p/${hubPeerId}/p2p-circuit`)]);
  } catch (err) {
    const { status, refusal } = classify(err);
    throw new HubReservationError(hubPeerId, status, refusal, { cause: err });
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
