/**
 * EXPERIMENTAL (issue #56): every exchange with a peer as a windowed virtual
 * port over ONE libp2p stream, instead of one libp2p stream per exchange.
 *
 * WHAT CHANGES ON THE WIRE. A caller opens one stream to the peer on a
 * separate protocol id (`muxProtocolOf(protocol)`, `/httpeers/1.0.0/mux` by
 * default) and runs `multiplexPort` (webrun-rpc) over it, with msgpack
 * envelopes, a per-port window and fair framing. Each HTTP exchange is then a
 * port on that mux, carried by `duplexOverPort` exactly as the MessagePort
 * test link carries it. The bridge above is unchanged: it still asks the link
 * for one duplex per call, and gets a port instead of a stream.
 *
 * WHY (measured upstream, loopback only): a stalled reader holds its own
 * port's window and nothing else, so it neither buffers without bound nor
 * delays other exchanges; a dead stream fails every open exchange at once.
 * The cost is small-message throughput. Whether to keep this, and for which
 * traffic, is the open part of #56.
 *
 * WHAT IT GUARANTEES:
 *
 *   - **Old and new peers never misread each other.** The mux has its own
 *     protocol id. A serving side with the flag serves BOTH protocols, so
 *     callers without it are unaffected. A caller with the flag whose peer
 *     does not speak the mux protocol (multistream-select answers "na") falls
 *     back to one stream per exchange for that peer's current connection
 *     (`fallback`, on by default), or fails with `PeerProtocolUnsupportedError`.
 *   - **One mux per peer and direction, opened lazily.** Concurrent first
 *     calls share one dial. The mux this side opened carries this side's
 *     calls; the far side's calls to us ride the mux IT opened. (Sharing one
 *     stream for both directions is possible, the id parity allows it, but it
 *     would couple the serving and calling halves, which today are built
 *     separately; left for later.)
 *   - **The mux dies with its stream.** `messageTargetOverStream`'s signal
 *     closes the mux when the stream or its connection dies, which aborts
 *     every port on it: open calls fail at once with `PeerGoneError` (mapped to
 *     `PeerStreamResetError` by the transport, as for a reset stream). The
 *     dead session is forgotten in the same turn, so the next call dials a new
 *     one: reconnection is just the next call.
 *   - **Teardown.** `close()` (and the serving teardown) close every mux this
 *     link holds; stopping the node closes their streams, which does the same.
 *
 * IDENTITY is still by closure: the serving side reads `remotePeer` from the
 * libp2p connection the mux stream arrived on, the Noise-proven id, and
 * builds each port's handler with it. Nothing inside the mux can claim
 * another peer.
 */

import type { Connection, Libp2p, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerConnection, PeerLink } from "@statewalker/httpeers-bridge";
import type { PeerIdStr, ProvenPeer } from "@statewalker/httpeers-core";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  DEFAULT_MAX_PORTS,
  duplexOverPort,
  type MessageTarget,
  multiplexPort,
  type PortMux,
  serveDuplexOverPort,
} from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import { messageTargetOverStream, PeerGoneError } from "@statewalker/webrun-streams-libp2p";

/** The mux protocol beside a fetch protocol: two meshes on one node keep two muxes apart. */
export function muxProtocolOf(protocol: string): string {
  return `${protocol}/mux`;
}

/** `muxProtocolOf(PROTOCOL)`, spelled out so this module needs nothing from `transport.ts`. */
export const MUX_PROTOCOL = "/httpeers/1.0.0/mux";

/**
 * 256 KiB: the window the #56 measurement used. Bulk throughput was about 77%
 * of one stream per exchange with it, and matched or beat it at 4 MiB, at the
 * price of slower pings under load (p50 8-10 ms rather than 2.9 ms).
 */
export const DEFAULT_MUX_WINDOW = 256 * 1024;

/**
 * 16 KiB: the low end of webrun-rpc's suggested range. A small message waits
 * for at most one frame of another port's large one.
 */
export const DEFAULT_MUX_FRAME_SIZE = 16 * 1024;

/**
 * Mux streams one connection may carry per protocol and direction. A caller
 * opens one per peer; a few more allow a reconnect to overlap a dying stream.
 */
export const MUX_MAX_STREAMS_PER_CONNECTION = 8;

/** The environment variable that turns the mux on where no option says otherwise (Node). */
export const MUX_PER_PEER_ENV = "HTTPEERS_LIBP2P_MUX_PER_PEER";
/** The same switch for a page, set on `globalThis` before the peer is built. */
export const MUX_PER_PEER_GLOBAL = "__HTTPEERS_LIBP2P_MUX_PER_PEER__";

/** Tuning for the experimental mux path. Every field is optional. */
export interface MuxPerPeerOptions {
  /** Per-port window, in bytes. Default {@link DEFAULT_MUX_WINDOW}. */
  window?: number;
  /** Fair-framing size, in bytes. Default {@link DEFAULT_MUX_FRAME_SIZE}. */
  frameSize?: number;
  /** Open ports (exchanges) one mux may hold. Default webrun-rpc's `DEFAULT_MAX_PORTS` (1024). */
  maxPorts?: number;
  /**
   * A CALLER whose peer does not speak the mux protocol uses one stream per
   * exchange instead, until that peer's connection is replaced (default).
   * `false` fails such calls with `PeerProtocolUnsupportedError`.
   */
  fallback?: boolean;
  /** Overrides the protocol id. Default `muxProtocolOf(protocol)`. */
  protocol?: string;
}

/** The flag as callers pass it: `true` for the defaults, or the tuning itself. */
export type MuxPerPeer = boolean | MuxPerPeerOptions;

/**
 * The flag in force: the option when given, else the environment switch
 * (`HTTPEERS_LIBP2P_MUX_PER_PEER=1` in Node, `globalThis.__HTTPEERS_LIBP2P_MUX_PER_PEER__`
 * in a page). The switch exists so a whole suite, built through layers that
 * do not forward the option, can run on the mux path; it is experimental and
 * goes away with the experiment.
 */
export function resolveMuxPerPeer(option: MuxPerPeer | undefined): MuxPerPeerOptions | undefined {
  const flag = option ?? muxPerPeerFromEnvironment();
  if (flag === false || flag == null) return undefined;
  return flag === true ? {} : flag;
}

function muxPerPeerFromEnvironment(): boolean {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    [MUX_PER_PEER_GLOBAL]?: unknown;
  };
  if (g[MUX_PER_PEER_GLOBAL] === true) return true;
  const value = g.process?.env?.[MUX_PER_PEER_ENV];
  return value === "1" || value === "true";
}

/** What `libp2pMuxLink` needs, beside the per-exchange link it falls back to and serves. */
export interface Libp2pMuxLinkInit {
  node: Libp2p;
  /** The per-exchange link: callers fall back to it, and the serving side serves it too. */
  perExchange: PeerLink;
  /** The fetch protocol; the mux protocol derives from it. */
  protocol: string;
  options: MuxPerPeerOptions;
  serveOnLimitedConnection?: boolean;
  /** Whether a call to `peerId` may open its stream on a limited connection. */
  limitedFor: (peerId: PeerIdStr) => boolean;
  /** The dialer for a limited target (the kept circuit first). */
  dialerFor: (peerId: PeerIdStr, limited: boolean) => Pick<Libp2p, "dialProtocol">;
}

/** A `PeerLink` that also lets go of its muxes. */
export interface ClosablePeerLink extends PeerLink {
  /** Close every mux this link opened or accepted. Idempotent. */
  close(): Promise<void>;
}

interface Session {
  mux: PortMux;
  /** Aborts when the mux is over, for whatever reason. */
  dead: AbortSignal;
  /** Close the mux (and so its stream and every port on it). */
  close(reason: unknown): Promise<void>;
}

/** Wrap a running node as a link whose exchanges share one mux per peer. */
export function libp2pMuxLink(init: Libp2pMuxLinkInit): ClosablePeerLink {
  const { node, perExchange, options } = init;
  const protocol = options.protocol ?? muxProtocolOf(init.protocol);
  const fallback = options.fallback ?? true;

  /** Outbound sessions, by peer. A pending dial is shared by every call that arrives meanwhile. */
  const outbound = new Map<PeerIdStr, Promise<Session>>();
  /** Every live session, both directions, so `close()` reaches them all. */
  const live = new Set<Session>();
  /**
   * Connections whose peer answered "na" to the mux protocol. Keyed by the
   * connection, so a peer that reconnects (perhaps upgraded) is asked again,
   * and nothing here outlives the connection it describes.
   */
  const refused = new WeakSet<Connection>();
  let closed = false;

  const startSession = (
    stream: Stream,
    side: "initiator" | "responder",
    onPort?: (port: MessageTarget) => boolean | undefined,
  ): Session => {
    const { target, signal } = messageTargetOverStream(stream);
    const dead = new AbortController();
    const mux = multiplexPort(target as unknown as MessageTarget, {
      codec: msgpackCodec,
      side,
      window: options.window ?? DEFAULT_MUX_WINDOW,
      frameSize: options.frameSize ?? DEFAULT_MUX_FRAME_SIZE,
      maxPorts: options.maxPorts ?? DEFAULT_MAX_PORTS,
      // The stream's death closes the mux, which fails every port on it.
      signal,
      ...(onPort == null ? {} : { onPort }),
    });
    const session: Session = {
      mux,
      dead: dead.signal,
      async close(reason) {
        dead.abort(reason);
        await mux.close(reason);
      },
    };
    live.add(session);
    dead.signal.addEventListener("abort", () => live.delete(session), { once: true });
    const onStreamGone = () => dead.abort(signal.reason);
    if (signal.aborted) onStreamGone();
    else signal.addEventListener("abort", onStreamGone, { once: true });
    // A stream that died before `messageTargetOverStream` was listening (the
    // peer negotiated the protocol, then refused it -- a limited connection
    // the peer does not serve on) fired its `close` already, and its signal
    // would never abort: every port on it would wait for the call's timeout.
    if (stream.status !== "open") {
      void session.close(new PeerGoneError()).catch(() => {});
    }
    return session;
  };

  const dial = async (peerId: PeerIdStr): Promise<Session> => {
    const limited = init.limitedFor(peerId);
    const stream = await init
      .dialerFor(peerId, limited)
      .dialProtocol(multiaddr(`/p2p/${peerId}`), [protocol], {
        maxOutboundStreams: MUX_MAX_STREAMS_PER_CONNECTION,
        // Fully: a peer without the protocol must say so now, not after the
        // first exchange has been written into a stream nobody reads.
        negotiateFully: true,
        ...(limited ? { runOnLimitedConnection: true } : {}),
      } as never);
    if (closed) {
      stream.abort(new Error("httpeers-libp2p: the link was closed"));
      throw new Error("httpeers-libp2p: the link was closed");
    }
    return startSession(stream, "initiator");
  };

  const sessionFor = (peerId: PeerIdStr): Promise<Session> => {
    const existing = outbound.get(peerId);
    if (existing != null) return existing;
    const opening = dial(peerId);
    outbound.set(peerId, opening);
    const drop = () => {
      if (outbound.get(peerId) === opening) outbound.delete(peerId);
    };
    opening.then((session) => {
      if (session.dead.aborted) drop();
      else session.dead.addEventListener("abort", drop, { once: true });
    }, drop);
    return opening;
  };

  const peerRefusedMux = (peerId: PeerIdStr): boolean =>
    node.getConnections(peerIdFromString(peerId)).some((c) => refused.has(c));

  const openPort = async (peerId: PeerIdStr): Promise<MessageTarget> => {
    // Twice at most: a session can die between being handed out and opening
    // its port (the stream reset in that window). The second attempt dials.
    for (let attempt = 0; ; attempt++) {
      const session = await sessionFor(peerId);
      try {
        return await session.mux.openPort({ kind: "httpeers" });
      } catch (error) {
        if (!session.dead.aborted) throw error;
        // What killed the session says more than "the multiplexer is closed":
        // a `PeerGoneError`, which maps to `PeerStreamResetError`.
        if (attempt > 0) throw session.dead.reason ?? error;
      }
    }
  };

  return {
    async open(peerId: PeerIdStr): Promise<PeerConnection> {
      if (closed) throw new Error("httpeers-libp2p: the link was closed");
      if (fallback && peerRefusedMux(peerId)) return perExchange.open(peerId);
      let port: MessageTarget;
      try {
        port = await openPort(peerId);
      } catch (error) {
        if (!fallback || !isUnsupportedProtocol(error)) throw error;
        for (const c of node.getConnections(peerIdFromString(peerId))) refused.add(c);
        return perExchange.open(peerId);
      }
      return {
        call: duplexOverPort(port) as Duplex,
        async close() {
          (port as { close?: () => void }).close?.();
        },
      };
    },

    async serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<() => Promise<void>> {
      // The per-exchange protocol first: a caller without the flag is served
      // exactly as before.
      const stopPerExchange = await perExchange.serve(handlerFor);
      const accepted = new Set<Session>();
      const onStream = (stream: Stream, connection: Connection): void => {
        // The Noise-proven peer of the connection this stream arrived on.
        // Every port on this mux is served as this peer, and nothing a port
        // carries can change it.
        const peer = connection.remotePeer.toString() as ProvenPeer;
        const session = startSession(stream, "responder", (port) => {
          serveDuplexOverPort(port, handlerFor(peer));
          return true;
        });
        accepted.add(session);
        session.dead.addEventListener("abort", () => accepted.delete(session), { once: true });
      };
      await node.handle(protocol, onStream as never, {
        maxInboundStreams: MUX_MAX_STREAMS_PER_CONNECTION,
        maxOutboundStreams: MUX_MAX_STREAMS_PER_CONNECTION,
        ...(init.serveOnLimitedConnection == null
          ? {}
          : { runOnLimitedConnection: init.serveOnLimitedConnection }),
      });
      let torn = false;
      return async () => {
        if (torn) return;
        torn = true;
        await node.unhandle(protocol).catch(() => {});
        const reason = new Error("httpeers-libp2p: the peer stopped serving");
        await Promise.all([...accepted].map((s) => s.close(reason).catch(() => {})));
        await stopPerExchange();
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      const reason = new Error("httpeers-libp2p: the link was closed");
      outbound.clear();
      await Promise.all([...live].map((s) => s.close(reason).catch(() => {})));
    },
  };
}

function isUnsupportedProtocol(error: unknown): boolean {
  return error instanceof Error && error.name === "UnsupportedProtocolError";
}
