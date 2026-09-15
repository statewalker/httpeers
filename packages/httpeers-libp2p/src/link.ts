/**
 * libp2p, as a `PeerLink`.
 *
 * This is the whole of what makes the bridge libp2p-specific: how to open a
 * duplex to a peer, and how to accept one. Everything the bridge does with
 * those duplexes -- binding the proven peer, one stream per call, the permit,
 * the timeout -- lives in `@statewalker/httpeers-bridge` and is shared with
 * every other transport, including the MessagePort one the tests use.
 *
 * `serveConnections` is used rather than `node.handle` by hand because it
 * already threads a `ConnectionContext`, and `context.remotePeer` is the
 * answer the Noise handshake established. That value is what the bridge binds
 * to every inbound request, and it is the reason a peer cannot lie about who
 * it is no matter what headers it sets.
 */

import type { Libp2p } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerConnection, PeerLink } from "@statewalker/httpeers-bridge";
import type { PeerIdStr, ProvenPeer } from "@statewalker/httpeers-core";
import type { Duplex } from "@statewalker/webrun-streams";
import {
  type ConnectionContext,
  connect,
  serveConnections,
} from "@statewalker/webrun-streams-libp2p";
import { DEFAULT_DRAIN_TIMEOUT_MS, DEFAULT_MAX_STREAMS, PROTOCOL } from "./transport.js";

export interface Libp2pLinkInit {
  node: Libp2p;
  /** Defaults to `PROTOCOL`. Two meshes on one node need two protocols. */
  protocol?: string;
  drainTimeoutMs?: number;
  maxInboundStreams?: number;
  maxOutboundStreams?: number;
  /**
   * Run the protocol over LIMITED connections (a relay circuit) too, in both
   * directions. Off by default: libp2p refuses, and that refusal is what keeps
   * application traffic off a relay's small budget. See `reachHubRelayed`.
   */
  runOnLimitedConnection?: boolean;
}

/** Wrap a running libp2p node as the one seam the bridge needs. */
export function libp2pLink(init: Libp2pLinkInit): PeerLink {
  const {
    node,
    protocol = PROTOCOL,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxInboundStreams = DEFAULT_MAX_STREAMS,
    maxOutboundStreams = DEFAULT_MAX_STREAMS,
    runOnLimitedConnection,
  } = init;

  return {
    async open(peerId: PeerIdStr): Promise<PeerConnection> {
      // A BARE `/p2p/<id>` dial, deliberately: a peer dialled once by full
      // multiaddr is dialable again by id alone, and composing an address here
      // would duplicate the routing decisions `reservation.ts` already made.
      const conn = await connect({
        node: runOnLimitedConnection === true ? keptCircuitFirst(node, peerId) : node,
        peer: multiaddr(`/p2p/${peerId}`),
        protocol,
        drainTimeoutMs,
        maxOutboundStreams,
        runOnLimitedConnection,
      });
      return { call: conn.call as Duplex, close: async () => await conn.close() };
    },

    async serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<() => Promise<void>> {
      return serveConnections(
        {
          node,
          protocol,
          drainTimeoutMs,
          maxInboundStreams,
          maxOutboundStreams,
          runOnLimitedConnection,
        },
        (context: ConnectionContext) => handlerFor(context.remotePeer.toString()) as never,
      );
    },
  };
}

/**
 * `node`, except that a stream to `peerId` opens on the LIMITED connection
 * already held to it when that is the only kind there is.
 *
 * WHY THE FLAG ALONE IS NOT ENOUGH. libp2p 3.3.8 does not reuse a limited
 * connection for a dial: `findExistingConnection`
 * (`connection-manager/utils.js`) returns only connections with
 * `limits == null`, so `dialProtocol` to a peer reachable only by a kept relay
 * circuit dials AGAIN, from the peer store -- a second circuit per call, through
 * whichever of the relay's addresses identify taught it. The
 * relay-fallback conformance test measured exactly that (two new connections
 * for two requests) before this existed. The kept connection is the one the
 * caller chose; the stream goes there.
 *
 * An UNLIMITED connection still wins when there is one (a WebRTC upgrade that
 * did come up): that case is left to libp2p's own dial, which reuses it.
 *
 * A NARROW STAND-IN, not a wrapper: `connect` (`webrun-streams-libp2p`) reads
 * nothing from the node but `dialProtocol`, and giving that package a way to
 * take a `Connection` would be a change in another repository for one caller.
 */
function keptCircuitFirst(node: Libp2p, peerId: PeerIdStr): Libp2p {
  const dialer: Pick<Libp2p, "dialProtocol"> = {
    dialProtocol: async (peer, protocols, options) => {
      const open = node.getConnections(peerIdFromString(peerId)).filter((c) => c.status === "open");
      const kept = open.some((c) => c.limits == null)
        ? undefined
        : open.find((c) => c.limits != null);
      return kept != null
        ? kept.newStream(protocols, options)
        : node.dialProtocol(peer, protocols, options);
    },
  };
  return dialer as Libp2p;
}
