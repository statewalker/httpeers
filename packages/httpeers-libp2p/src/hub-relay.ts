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
 */

import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import type { ConnectionGater, PeerId } from "@libp2p/interface";
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
 * The circuit-relay server a hub runs for its members.
 *
 * The default limits are stated explicitly rather than left implicit, so that
 * nobody raises them to "make it smoother": they are the thing that keeps a
 * hub a signalling channel instead of a data path.
 */
export function hubRelayService() {
  return circuitRelayServer({ reservations: { applyDefaultLimit: true } });
}
