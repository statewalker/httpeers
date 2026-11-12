/**
 * The NODE half of `MemberPlatform` — the counterpart to
 * `./browser-profile.ts`'s `createBrowserNode`.
 *
 * WHAT DIFFERS FROM THE BROWSER PROFILE, AND WHAT DELIBERATELY DOES NOT:
 *
 *   - `tcp()` is added. It is the one transport a page cannot have and the
 *     one a Node member wants, for the direct member-to-member hop a page
 *     makes over WebRTC instead.
 *   - The LISTEN ADDRESSES ARE THE SAME — `/p2p-circuit` and `/webrtc`,
 *     plus a loopback TCP port. If a Node member listened differently it
 *     would reserve somewhere else, and the rung would be testing a
 *     different design rather than the same one on another platform.
 *   - The connection gater is permissive, which the browser profile also
 *     does for loopback and private addresses (`dialNeedsPermissiveGater`).
 *     Node has no browser default to relax, so this is the same policy
 *     arrived at from the other side.
 *   - There is no `mountEdge`: `MemberHandle.fetch` is the edge under Node.
 *   - There is no `watchWake`: a Node process gets no wake events, so the
 *     supervisor's backstop timer is the whole story.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import {
  CONNECTION_LIVENESS_SERVICE,
  connectionLiveness,
  type IceServer,
  webRTCInitOf,
} from "@statewalker/httpeers-libp2p";
import { warnIfOldLibdatachannel } from "@statewalker/httpeers-libp2p/node";
import { createLibp2p } from "libp2p";
import type { MemberPlatform } from "./start-member.js";

export async function createNodeMemberNode(init: {
  privateKey?: Ed25519PrivateKey;
  /**
   * WebRTC's STUN/TURN servers. Unset keeps `@libp2p/webrtc`'s own public
   * default; `HTTPEERS_ICE_SERVERS` opts into the mesh's server. See
   * `@statewalker/httpeers-libp2p`'s `ice-servers.ts`.
   */
  iceServers?: readonly IceServer[];
}): Promise<Libp2p> {
  // Once per process: this peer dials WebRTC once, which needs libdatachannel >= 0.24.6.
  warnIfOldLibdatachannel();
  return createLibp2p({
    ...(init.privateKey != null ? { privateKey: init.privateKey } : {}),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"] },
    transports: [
      webSockets(),
      circuitRelayTransport(),
      webRTC(webRTCInitOf(init.iceServers) as Parameters<typeof webRTC>[0]),
      tcp(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: async () => false },
    // As `createNode`: abort a connection on a failed ping only when it went
    // silent, never one that is busy receiving (libp2p's monitor would).
    connectionMonitor: { enabled: false },
    services: { identify: identify(), [CONNECTION_LIVENESS_SERVICE]: connectionLiveness() },
  });
}

/** The whole Node platform: a node factory, and nothing else. */
export const nodePlatform: MemberPlatform = { createNode: createNodeMemberNode };

/**
 * `nodePlatform` with a choice of WebRTC ICE servers, e.g.
 * `nodePlatformWith({ iceServers: HTTPEERS_ICE_SERVERS })`. Unset is `nodePlatform`.
 */
export function nodePlatformWith(init: { iceServers?: readonly IceServer[] }): MemberPlatform {
  return {
    createNode: ({ privateKey }) =>
      createNodeMemberNode({
        ...(privateKey != null ? { privateKey } : {}),
        ...(init.iceServers != null ? { iceServers: init.iceServers } : {}),
      }),
  };
}
