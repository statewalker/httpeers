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
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerConnection, PeerLink } from "@statewalker/httpeers-bridge";
import type { PeerIdStr, ProvenPeer } from "@statewalker/httpeers-core";
import type { Duplex } from "@statewalker/webrun-streams";
import { connect, type ConnectionContext, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { DEFAULT_DRAIN_TIMEOUT_MS, DEFAULT_MAX_STREAMS, PROTOCOL } from "./transport.js";

export interface Libp2pLinkInit {
  node: Libp2p;
  /** Defaults to `PROTOCOL`. Two meshes on one node need two protocols. */
  protocol?: string;
  drainTimeoutMs?: number;
  maxInboundStreams?: number;
  maxOutboundStreams?: number;
}

/** Wrap a running libp2p node as the one seam the bridge needs. */
export function libp2pLink(init: Libp2pLinkInit): PeerLink {
  const {
    node,
    protocol = PROTOCOL,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxInboundStreams = DEFAULT_MAX_STREAMS,
    maxOutboundStreams = DEFAULT_MAX_STREAMS,
  } = init;

  return {
    async open(peerId: PeerIdStr): Promise<PeerConnection> {
      // A BARE `/p2p/<id>` dial, deliberately: a peer dialled once by full
      // multiaddr is dialable again by id alone, and composing an address here
      // would duplicate the routing decisions `reservation.ts` already made.
      const conn = await connect({
        node,
        peer: multiaddr(`/p2p/${peerId}`),
        protocol,
        drainTimeoutMs,
        maxOutboundStreams,
      });
      return { call: conn.call as Duplex, close: async () => await conn.close() };
    },

    async serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<() => Promise<void>> {
      return serveConnections(
        { node, protocol, drainTimeoutMs, maxInboundStreams, maxOutboundStreams },
        (context: ConnectionContext) => handlerFor(context.remotePeer.toString()) as never,
      );
    },
  };
}
