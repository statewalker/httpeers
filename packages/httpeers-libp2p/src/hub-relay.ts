/**
 * The hub as a relay for its own members — signalling only, members only.
 *
 * WHY A HUB RELAYS AT ALL. Members reach each other through their hub rather
 * than through the public relay: the hub is the one peer every member is
 * already connected to and heartbeating against, so it can carry the few
 * kilobytes of WebRTC offer/answer between two members, after which they talk
 * directly. The public relay is then needed only to reach the hub itself.
 *
 * MEMBERS ONLY. `membershipGater` refuses a reservation from a non-member and
 * refuses to relay unless BOTH ends are members. A non-member can still
 * *connect* to a hub — it must, to redeem an invitation — it simply cannot use
 * the hub to reach anyone else. The public relay, by contrast, connects anyone
 * to any reserved peer whose id they know.
 *
 * SIGNALLING ONLY, ENFORCED RATHER THAN HOPED FOR. `hubRelayService` keeps
 * libp2p's default per-circuit limits (128 KiB, 2 min), sized for an SDP
 * exchange. A circuit carrying limits is a LIMITED connection, and libp2p
 * refuses to open an application protocol on one — so application data cannot
 * cross a hub by accident. When two members cannot connect directly, WebRTC
 * falls back to TURN, never to the hub.
 *
 * Opening a protocol with `runOnLimitedConnection` would bypass that, and the
 * prototype measured the result: a 1 MiB transfer silently cut at 112 KiB.
 * **Nothing may set it for application traffic.**
 *
 * HOW MANY, AND FOR HOW LONG -- a different question from how much. The data
 * limits above bound what one CIRCUIT may carry. The reservation store bounds
 * how many members may be REACHABLE through the hub at once, and libp2p's
 * default for it (15, each held for two hours, kept after its holder hangs
 * up) is sized for a public relay, not for a hub. A hub on that default
 * filled after fifteen distinct peers in two hours -- test runs, revoked
 * members, a member whose page was reopened -- and then refused every member
 * with `RESERVATION_REFUSED`, which a member reports as a failed join. So:
 *
 *   - the store is sized for a mesh (`HUB_MAX_RESERVATIONS`), which is safe
 *     because only members can take a slot;
 *   - a reservation is released when its holder's last connection closes
 *     (it is useless from then on: libp2p relays only to a CONNECTED
 *     reservation holder, and a member re-reserves when it comes back);
 *   - `releaseReservation` lets the hub release a REVOKED member's
 *     reservation at once, rather than leave the slot held until expiry.
 */

import {
  type CircuitRelayServerComponents,
  type CircuitRelayService,
  circuitRelayServer,
} from "@libp2p/circuit-relay-v2";
import type { ConnectionGater, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { PeerIdStr } from "@statewalker/httpeers-core";

/** Is this peer a member of our mesh? Read LIVE — see `membershipGater`. */
export type IsMember = (peerId: PeerIdStr) => boolean;

/**
 * A gater that admits only members to the relay.
 *
 * TAKES A THUNK, and that is not a style preference — it breaks a genuine
 * ordering cycle. The gater is needed to CREATE the node; the answer to "is
 * this peer a member" comes from the hub's member store; and the hub cannot be
 * built until the node exists. Passing `isMember` directly forces a caller to
 * resolve that cycle themselves, and the prototype's two profiles each did it
 * differently.
 *
 * A thunk defers the lookup to the moment a decision is actually needed, by
 * which time the hub exists. It also means a revocation takes effect on the
 * next relay request rather than at the next restart, because nothing is
 * captured.
 */
export function membershipGater(isMember: () => IsMember): ConnectionGater {
  return {
    denyInboundRelayReservation: async (source: PeerId) => !isMember()(source.toString()),
    denyOutboundRelayedConnection: async (source: PeerId, destination: PeerId) => {
      const member = isMember();
      // BOTH ends. A member must not be able to use the hub to reach a
      // stranger any more than a stranger may use it to reach a member.
      return !member(source.toString()) || !member(destination.toString());
    },
  };
}

/**
 * How many members may hold a reservation on a hub at once: one per member
 * currently connected to it.
 *
 * WHY THIS NUMBER. It is a ceiling, not an allocation -- an empty slot costs
 * nothing, and a held one is a map entry of a few hundred bytes, so 4096 of
 * them is about a megabyte. Only members can take a slot (`membershipGater`),
 * and a slot is given back when its holder disconnects, so what this really
 * bounds is simultaneously connected members; a hub serving thousands of
 * members at once has other limits to meet first (libp2p's connection
 * manager, the hub's own CPU). libp2p's default, 15, is sized for a public
 * relay that anyone can fill, and is the value that broke a real hub.
 *
 * NOT RAISED TO "UNLIMITED", because the gater is the only thing between a
 * large member list and this map; a finite ceiling keeps a runaway (a bug
 * that mints members, say) from growing it without bound.
 */
export const HUB_MAX_RESERVATIONS = 4096;

export interface HubRelayServiceInit {
  /**
   * The reservation store's size (default `HUB_MAX_RESERVATIONS`). How MANY
   * members can be reached through the hub -- not how much data may cross it,
   * which stays at libp2p's signalling-sized default whatever this is.
   */
  maxReservations?: number;
}

/**
 * What the hub relay needs from the node: the relay server's own components,
 * plus the node's event bus, to hear a holder hang up. Both are standard
 * libp2p components; `createLibp2p` hands every service all of them.
 */
export type HubRelayComponents = CircuitRelayServerComponents & {
  events: TypedEventTarget<Libp2pEvents>;
};

/**
 * The circuit-relay server a hub runs for its members.
 *
 * The default DATA limits are stated explicitly rather than left implicit, so
 * that nobody raises them to "make it smoother": they are the thing that keeps
 * a hub a signalling channel instead of a data path. The store's SIZE is a
 * separate setting (`init.maxReservations`) and changes none of that.
 *
 * RELEASES ON DISCONNECT. libp2p keeps a reservation for its full TTL after
 * the holder is gone. This listens for `peer:disconnect` -- which libp2p
 * fires when a peer's LAST connection closes -- and releases the reservation
 * then, rechecking that no connection came back in the meantime.
 */
export function hubRelayService(
  init: HubRelayServiceInit = {},
): (components: HubRelayComponents) => CircuitRelayService {
  const createServer = circuitRelayServer({
    reservations: {
      applyDefaultLimit: true,
      maxReservations: init.maxReservations ?? HUB_MAX_RESERVATIONS,
    },
  });
  return (components) => {
    const relay = createServer(components);
    components.events.addEventListener("peer:disconnect", (event) => {
      const peer = event.detail;
      if (components.connectionManager.getConnections(peer).length > 0) return;
      releaseReservation(relay, peer);
    });
    return relay;
  };
}

/**
 * Release a peer's reservation on this hub's relay, now. Returns whether there
 * was one. The daemon calls it when it revokes a member; the membership gater
 * already refuses that peer a NEW reservation, and this frees the one it held.
 *
 * THROUGH THE SERVICE'S PUBLIC SURFACE. libp2p offers no "remove reservation"
 * call, but `CircuitRelayService.reservations` is a public map and each entry
 * carries its expiry `signal`. Clearing that signal before removing the entry
 * matters: the store's own expiry listener deletes by PEER, so a timer left
 * running would, two hours later, delete whatever reservation the same peer
 * holds by then.
 *
 * A STRING THAT IS NOT A PEER ID holds no reservation, so it returns false
 * rather than throwing: a revocation must not fail half-way over it.
 */
export function releaseReservation(
  relay: Pick<CircuitRelayService, "reservations">,
  peer: PeerId | PeerIdStr,
): boolean {
  const peerId = typeof peer === "string" ? parsePeerId(peer) : peer;
  if (peerId == null) return false;
  const reservation = relay.reservations.get(peerId);
  if (reservation == null) return false;
  reservation.signal.clear();
  relay.reservations.delete(peerId);
  return true;
}

function parsePeerId(peer: PeerIdStr): PeerId | undefined {
  try {
    return peerIdFromString(peer);
  } catch {
    return undefined;
  }
}
