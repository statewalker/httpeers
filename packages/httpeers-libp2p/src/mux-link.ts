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
 *   - **The mux dies with its stream.** `muxTargetOverStream`'s signal
 *     closes the mux when the stream or its connection dies, which aborts
 *     every port on it: open calls fail at once with `PeerGoneError` (mapped to
 *     `PeerStreamResetError` by the transport, as for a reset stream). The
 *     dead session is forgotten in the same turn, so the next call dials a new
 *     one: reconnection is just the next call. A mux that closes ITSELF (its
 *     keepalive finding the peer silent while the stream still looks alive,
 *     its pump failing) dies the same way: same error, same redial
 *     (`startSession`, "the one way a session dies").
 *   - **The serving side keeps the per-exchange path's bounds.** At most
 *     `maxInboundStreams` (512) exchanges at once per CONNECTION, counted
 *     across every mux on it (a port past the cap is refused, and the caller
 *     sees `PeerStreamResetError`, as for a refused stream); an exchange whose
 *     response write stays blocked on the caller (no window credit) for
 *     `drainTimeoutMs` (15 s) is dropped, so a peer that withholds credit
 *     cannot pin a handler, while a merely quiet exchange (an SSE stream
 *     between events, a slow response head, an idle tunnel) is never dropped
 *     for its silence, exactly as on the per-exchange path; one message on
 *     the stream is at most a frame plus headroom, and reassembly past the
 *     windows is capped at one window; a keepalive closes a mux whose peer
 *     froze.
 *   - **Teardown.** `close()` (and the serving teardown) close every mux this
 *     link holds; stopping the node closes their streams, which does the same.
 *
 * LOADED ON DEMAND. `@statewalker/webrun-rpc` and `@statewalker/webrun-msgpack`
 * are imported dynamically the first time a mux link opens or serves, so a
 * consumer that never sets the flag does not load (or bundle into its main
 * chunk) either.
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
import type { MessageTarget, PortMux } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import { PeerGoneError } from "@statewalker/webrun-streams-libp2p";
import { gatheringChunks } from "./chunk-gather.js";
import { muxTargetOverStream } from "./mux-target.js";

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
 * 31 KiB. A small message waits for at most one frame of another port's large
 * one (about 0.2 ms at loopback speed). Stream chunks are split to fit it too,
 * so no message on the stream is much larger.
 *
 * WHY THIS SIZE. Each message costs the mux, its codec and libp2p a fixed
 * amount, so larger frames carry bulk for less CPU: 31 KiB carries about 15%
 * more than 16 KiB on loopback (`scripts/bench-mux.mjs`, #56). Such a frame
 * goes out as one write of its own (`mux-target.ts` gathers only smaller
 * ones, up to 16 KiB), one Noise message. And a frame plus its envelope
 * stays within 32 KiB, the largest message a build on the earlier
 * (unreleased) 16 KiB default accepts (`frameSize + MUX_MESSAGE_HEADROOM`),
 * so such a peer still reads what this side sends.
 */
export const DEFAULT_MUX_FRAME_SIZE = 31 * 1024;

/**
 * Room on top of `frameSize` for one message on the stream: the mux's and the
 * stream's own envelopes (about 130 bytes per chunk, measured upstream), and
 * a serialized error, which is not split.
 */
export const MUX_MESSAGE_HEADROOM = 16 * 1024;

/**
 * Mux streams one connection may carry per protocol and direction. A caller
 * opens one per peer and link; a few more allow a reconnect to overlap a dying
 * stream. A link that finds them all taken uses a stream per exchange instead.
 */
export const MUX_MAX_STREAMS_PER_CONNECTION = 8;

/**
 * The keepalive's interval: a mux whose peer answers none of three pings in a
 * row (15 s) closes, failing its exchanges, even when libp2p has not noticed
 * the connection is gone.
 */
export const DEFAULT_MUX_KEEPALIVE_MS = 5_000;

/** Keepalive intervals in a row with nothing from the peer before the mux closes (webrun-rpc's default). */
const KEEPALIVE_MISSES = 3;

/** Tuning for the experimental mux path. Every field is optional. */
export interface MuxPerPeerOptions {
  /** Per-port window, in bytes. Default {@link DEFAULT_MUX_WINDOW}. */
  window?: number;
  /** Fair-framing size, and the size stream chunks are split to, in bytes. Default {@link DEFAULT_MUX_FRAME_SIZE}. */
  frameSize?: number;
  /**
   * The largest message accepted on the stream, in bytes; a peer that sends a
   * larger one is not speaking this protocol and the stream is aborted.
   * Default `frameSize + MUX_MESSAGE_HEADROOM`.
   */
  maxMessageBytes?: number;
  /**
   * What the mux holds of a peer's framed messages past their windows, summed
   * over its ports, in bytes. Default: one `window`.
   */
  maxReassembledBytes?: number;
  /**
   * Ports one mux's table may hold. Default: the link's `maxInboundStreams`
   * (512). The serving side also caps exchanges per CONNECTION at
   * `maxInboundStreams`, across all of its muxes.
   */
  maxPorts?: number;
  /** Keepalive interval in ms; `0` turns it off. Default {@link DEFAULT_MUX_KEEPALIVE_MS}. */
  keepaliveMs?: number;
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

/** The flag in force, or `undefined` for the default per-exchange path. Only the option decides. */
export function resolveMuxPerPeer(option: MuxPerPeer | undefined): MuxPerPeerOptions | undefined {
  if (option == null || option === false) return undefined;
  return option === true ? {} : option;
}

/**
 * A port the serving side closed: refused past its cap, dropped after its
 * response write stayed blocked for `drainTimeoutMs`, or torn down. Mapped to
 * `PeerStreamResetError`, as a refused or reset stream is on the per-exchange
 * path.
 */
export class MuxPortClosedError extends Error {
  override name = "MuxPortClosedError";
}

/** What webrun-rpc says when the peer closed a port. */
const PEER_CLOSED_PORT = "webrun-rpc: the peer closed the port";

/**
 * How webrun-rpc's error begins when it fails a port whose presumed ack the
 * peer contradicted (`presumeAck`), once the port had sent something.
 */
const PRESUMPTION_CONTRADICTED = "webrun-rpc: the peer acknowledged port ";

type MuxLibs = {
  rpc: typeof import("@statewalker/webrun-rpc");
  codec: typeof import("@statewalker/webrun-msgpack")["msgpackCodec"];
};
let muxLibs: Promise<MuxLibs> | undefined;
/** webrun-rpc and webrun-msgpack, loaded once, the first time a mux link needs them. */
function loadMuxLibs(): Promise<MuxLibs> {
  muxLibs ??= Promise.all([
    import("@statewalker/webrun-rpc"),
    import("@statewalker/webrun-msgpack"),
  ]).then(([rpc, msgpack]) => ({ rpc, codec: msgpack.msgpackCodec }));
  return muxLibs;
}

/** What `libp2pMuxLink` needs, beside the per-exchange link it falls back to and serves. */
export interface Libp2pMuxLinkInit {
  node: Libp2p;
  /** The per-exchange link: callers fall back to it, and the serving side serves it too. */
  perExchange: PeerLink;
  /** The fetch protocol; the mux protocol derives from it. */
  protocol: string;
  options: MuxPerPeerOptions;
  /** Exchanges served at once per connection, across its muxes; and the default port table. */
  maxInboundStreams: number;
  /** A served exchange whose response write stays blocked on the caller this long is dropped. */
  drainTimeoutMs: number;
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
  /**
   * Aborts once when the mux is over, for whatever reason: with the reason
   * given to `close()`, or with a `PeerGoneError` when the mux closed itself
   * (its keepalive, its stream's end, death or a malformed frame, its pump).
   */
  dead: AbortSignal;
  /** Close the mux (and so its stream and every port on it) on purpose. */
  close(reason: unknown): Promise<void>;
  /**
   * An error read from `port`, one of this mux's, as the exchange should see
   * it: see {@link peerGoneFailure}.
   */
  failure(error: unknown, port: MessageTarget): unknown;
}

/**
 * `error`, read from a port whose close signal aborted with `closedWith`, as
 * the exchange should see it, given the session's `dead` signal. Once the mux
 * died otherwise than on purpose (`dead` aborted with a `PeerGoneError`), the
 * error the mux failed the port with (its keepalive's "the peer did not
 * answer", a stream's plain end), matched by identity, becomes a
 * `PeerGoneError` (mapped to `PeerStreamResetError`). Anything else is left as
 * it is: an error the peer sent before the death (a handler's own, rebuilt
 * with its name), a port the peer closed, a `PeerGoneError` already, and
 * every error after a close on purpose (the link's own `close()`).
 *
 * @internal Exported for its tests only; not part of the package's API.
 */
export function peerGoneFailure(error: unknown, closedWith: unknown, dead: AbortSignal): unknown {
  if (!dead.aborted || !(dead.reason instanceof PeerGoneError)) return error;
  if (error !== closedWith || error instanceof PeerGoneError || isPeerClosedPort(error)) {
    return error;
  }
  return new PeerGoneError(error);
}

/** Why a mux that closed itself died, as the peer-gone error every exchange on it sees. */
function peerGone(reason: unknown): PeerGoneError {
  return reason instanceof PeerGoneError ? reason : new PeerGoneError(reason);
}

/** Wrap a running node as a link whose exchanges share one mux per peer. */
export function libp2pMuxLink(init: Libp2pMuxLinkInit): ClosablePeerLink & {
  /** @internal The sessions alive now, both directions: for tests only. */
  liveSessions(): number;
} {
  const { node, perExchange, options } = init;
  const protocol = options.protocol ?? muxProtocolOf(init.protocol);
  const fallback = options.fallback ?? true;
  const windowBytes = options.window ?? DEFAULT_MUX_WINDOW;
  const frameSize = options.frameSize ?? DEFAULT_MUX_FRAME_SIZE;
  const maxMessageBytes = options.maxMessageBytes ?? frameSize + MUX_MESSAGE_HEADROOM;
  const maxReassembledBytes = options.maxReassembledBytes ?? windowBytes;
  const maxPorts = options.maxPorts ?? init.maxInboundStreams;
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_MUX_KEEPALIVE_MS;
  // Chunks split below the frame, so a chunk's envelope still fits in one.
  const maxChunkBytes = Math.max(1024, frameSize - 1024);

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
    libs: MuxLibs,
    stream: Stream,
    side: "initiator" | "responder",
    onPort?: (port: MessageTarget) => boolean | undefined,
  ): Session => {
    const { target: pipe, signal } = muxTargetOverStream(stream, { maxMessageBytes });
    const dead = new AbortController();
    // THE ONE WAY A SESSION DIES. However the mux closes -- `close()` here,
    // its stream's end or death (`signal`), or on its own (its keepalive
    // finding the peer silent, its pump failing) -- it releases its pipe last,
    // after failing its ports, in the same turn. That release aborts `dead`,
    // once, so the session is dropped (the next call dials) and its timers
    // and listeners go, whichever path closed it. A close not asked for here
    // dies of a `PeerGoneError`: the stream's own reason when the stream
    // ended, else the mux giving up on its peer.
    const target = releasing(pipe as unknown as MessageTarget, () => {
      if (dead.signal.aborted) return;
      dead.abort(
        peerGone(
          signal.aborted
            ? signal.reason
            : new Error("httpeers-libp2p: the multiplexer closed itself (keepalive or transport)"),
        ),
      );
    });
    const mux = libs.rpc.multiplexPort(target, {
      codec: libs.codec,
      side,
      // The caller takes each port's window agreement as given when it opens
      // (webrun-rpc's `presumeAck`), which saves the handshake's round trip in
      // both directions: an exchange takes one round trip. "always", from the
      // first port: every build that has served this protocol runs webrun-rpc
      // 0.10 or later with the msgpack codec, and acks every windowed `open`
      // with exact sizing and `pipeline`. An ack that says otherwise stops
      // presuming on that mux and fails only a port that already sent
      // something; the mux lives on. The serving side opens no ports.
      ...(side === "initiator" ? { presumeAck: "always" as const } : {}),
      window: windowBytes,
      frameSize,
      maxReassembledBytes,
      maxPorts,
      maxMessageSize: maxChunkBytes,
      ...(keepaliveMs > 0
        ? { keepalive: { intervalMs: keepaliveMs, misses: KEEPALIVE_MISSES } }
        : {}),
      // The stream's death closes the mux, which fails every port on it.
      signal,
      ...(onPort == null ? {} : { onPort }),
    });
    const opened: Session = {
      mux,
      dead: dead.signal,
      async close(reason) {
        if (!dead.signal.aborted) dead.abort(reason);
        await mux.close(reason);
      },
      failure(error, port) {
        return peerGoneFailure(error, libs.rpc.getPortCloseSignal(port)?.reason, dead.signal);
      },
    };
    const onStreamGone = () => {
      // A backstop: the mux, listening first, has normally released its pipe already.
      if (!dead.signal.aborted) dead.abort(peerGone(signal.reason));
    };
    const cleanUp = () => {
      live.delete(opened);
      signal.removeEventListener("abort", onStreamGone);
    };
    // A mux that closed while it was being built has aborted `dead` already:
    // clean up at once rather than wait for an event that has fired.
    if (dead.signal.aborted) {
      cleanUp();
      return opened;
    }
    live.add(opened);
    dead.signal.addEventListener("abort", cleanUp, { once: true });
    if (signal.aborted) onStreamGone();
    else signal.addEventListener("abort", onStreamGone, { once: true });
    // A stream that died, or that the peer half-closed, before
    // `muxTargetOverStream` was listening (the peer negotiated the
    // protocol, then refused it -- a limited connection the peer does not
    // serve on) fired its event already, and its signal would never abort:
    // every port on it would wait for the call's timeout.
    if (
      stream.status !== "open" ||
      stream.remoteWriteStatus !== "writable" ||
      stream.readStatus === "closed"
    ) {
      void opened.close(new PeerGoneError()).catch(() => {});
    }
    return opened;
  };

  const dial = async (peerId: PeerIdStr): Promise<Session> => {
    // Counted here rather than left to libp2p: past the cap it is the PEER
    // that resets the stream (its inbound check), which looks like a dead
    // peer rather than a full table.
    const taken = node
      .getConnections(peerIdFromString(peerId))
      .filter((c) => c.status === "open")
      .map(
        (c) =>
          c.streams.filter((st) => st.protocol === protocol && st.direction === "outbound").length,
      );
    if (taken.length > 0 && Math.min(...taken) >= MUX_MAX_STREAMS_PER_CONNECTION) {
      const full = new Error(`httpeers-libp2p: every ${protocol} stream to ${peerId} is taken`);
      full.name = "TooManyOutboundProtocolStreamsError";
      throw full;
    }
    // A connection that is going away can still be listed as open with its
    // muxer already closed (a peer that just died): libp2p would reuse it,
    // and fail the dial with `ConnectionClosedError`. Let it go first, so the
    // dial opens a new one.
    for (const c of node.getConnections(peerIdFromString(peerId))) {
      if (c.status === "open" && muxerClosed(c)) {
        c.abort(new Error("httpeers-libp2p: the connection's muxer is closed"));
      }
    }
    const limited = init.limitedFor(peerId);
    const [libs, stream] = await Promise.all([
      loadMuxLibs(),
      init.dialerFor(peerId, limited).dialProtocol(multiaddr(`/p2p/${peerId}`), [protocol], {
        maxOutboundStreams: MUX_MAX_STREAMS_PER_CONNECTION,
        // Fully: a peer without the protocol must say so now, not after the
        // first exchange has been written into a stream nobody reads.
        negotiateFully: true,
        ...(limited ? { runOnLimitedConnection: true } : {}),
      } as never),
    ]);
    if (closed) {
      stream.abort(new Error("httpeers-libp2p: the link was closed"));
      throw new Error("httpeers-libp2p: the link was closed");
    }
    return startSession(libs, stream, "initiator");
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

  const openPort = async (
    peerId: PeerIdStr,
  ): Promise<{ port: MessageTarget; session: Session }> => {
    // Twice at most: a session can die between being handed out and opening
    // its port (the stream reset in that window). The second attempt dials.
    for (let attempt = 0; ; attempt++) {
      let session: Session;
      try {
        session = await sessionFor(peerId);
      } catch (error) {
        // The connection closed under the dial (the peer just died, and
        // libp2p still listed it): once, a task later, dial again, on a new
        // connection.
        if (attempt > 0 || !isConnectionClosed(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      try {
        return { port: await session.mux.openPort({ kind: "httpeers" }), session };
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
      let session: Session;
      try {
        ({ port, session } = await openPort(peerId));
      } catch (error) {
        // Every mux stream this connection allows is taken (by other links
        // to the same peer): this call goes the per-exchange way.
        if (isStreamLimit(error)) return perExchange.open(peerId);
        if (!fallback || !isUnsupportedProtocol(error)) throw error;
        for (const c of node.getConnections(peerIdFromString(peerId))) refused.add(c);
        return perExchange.open(peerId);
      }
      const { rpc } = await loadMuxLibs();
      const duplex = rpc.duplexOverPort(port, { maxMessageSize: maxChunkBytes });
      return {
        // The pieces of the request written back to back go as one message,
        // not one each (`chunk-gather.ts`): fewer envelopes per exchange.
        call: ((input: AsyncIterable<Uint8Array>) =>
          mappingErrors(
            duplex(gatheringChunks(input[Symbol.asyncIterator](), maxChunkBytes)),
            (error) =>
              peerClosedPort(
                contradictedPort(session.failure(error, port), rpc.getPortCloseSignal(port)),
              ),
          )) as Duplex,
        async close() {
          (port as { close?: () => void }).close?.();
        },
      };
    },

    async serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<() => Promise<void>> {
      // The per-exchange protocol first: a caller without the flag is served
      // exactly as before.
      const stopPerExchange = await perExchange.serve(handlerFor);
      const libs = await loadMuxLibs();
      const accepted = new Set<Session>();
      /**
       * Exchanges being served, per connection, across all of its muxes: the
       * per-exchange path's `maxInboundStreams` contract, which counts streams
       * per connection, kept for ports.
       */
      const servedOn = new WeakMap<Connection, { open: number }>();
      const onStream = (stream: Stream, connection: Connection): void => {
        // The Noise-proven peer of the connection this stream arrived on.
        // Every port on this mux is served as this peer, and nothing a port
        // carries can change it.
        const peer = connection.remotePeer.toString() as ProvenPeer;
        let count = servedOn.get(connection);
        if (count == null) {
          count = { open: 0 };
          servedOn.set(connection, count);
        }
        const served = count;
        const session = startSession(libs, stream, "responder", (port) => {
          if (served.open >= init.maxInboundStreams) return false;
          served.open += 1;
          const portClosed = libs.rpc.getPortCloseSignal(port);
          portClosed?.addEventListener("abort", () => (served.open -= 1), { once: true });
          const handler = handlerFor(peer);
          // An exchange that ends abnormally (dropped stalled, abandoned, failed)
          // closes its port once its abort notice is posted: the notice alone
          // may sit behind a full window, leaving the caller waiting and the
          // port counted here. One that finishes ends both directions
          // (half-close) and frees the port itself.
          const closePort = () => setTimeout(() => (port as { close?: () => void }).close?.(), 0);
          // No idle `timeout`: silence is not a stall. A response write that
          // stays blocked on the caller for `drainTimeoutMs` drops the
          // exchange instead, as the per-exchange path drops a stream whose
          // write never drains: the port closes (and stops being counted) and
          // the handler's output is ended. The close also covers a stall on
          // the stream's last message, after the output already finished, and
          // a port the caller never answered the handshake for, which only its
          // close would free otherwise (see `droppingStalledWrites`).
          libs.rpc.serveDuplexOverPort(
            port,
            (input) => {
              const output: AsyncGenerator<Uint8Array> = onAbnormalEnd(
                // The pieces of the response written back to back go as one
                // message, not one each (`chunk-gather.ts`); inside the stall
                // watch, which times the caller and not the handler.
                droppingStalledWrites(
                  gatheringChunks(
                    // A request body cut short by the mux's death fails with
                    // what the session died of (`PeerGoneError`), as the
                    // caller's exchanges do, not with the mux's own reason.
                    handler(
                      mappingErrors(asyncIteratorOf(input), (error) =>
                        session.failure(error, port),
                      ),
                    ),
                    maxChunkBytes,
                  ),
                  {
                    rpc: libs.rpc,
                    port,
                    pieceBytes: maxChunkBytes,
                    timeoutMs: init.drainTimeoutMs,
                    onStall: () => {
                      // Close the port FIRST, synchronously, and only then end
                      // the output. Ended first, the output looks finished: the
                      // serving pump would post a clean end of stream before a
                      // deferred close, and the caller would read a truncated
                      // body as complete (an `HttpParseError` mid-chunk) rather
                      // than see the exchange reset. Closed first, the pump is
                      // aborted, posts nothing more, and the caller gets the
                      // close: `MuxPortClosedError`, mapped to `PeerStreamResetError`.
                      (port as { close?: () => void }).close?.();
                      void output.return(undefined).catch(() => {});
                    },
                  },
                ),
                closePort,
              );
              // The mux's death tears the exchange down with what the session
              // died of, so the handler's request body and its request's
              // signal fail with `PeerGoneError` too, not with webrun-http-
              // streams' "abandoned".
              return returningAsDeath(output, () =>
                portClosed?.aborted ? session.failure(portClosed.reason, port) : undefined,
              );
            },
            { maxMessageSize: maxChunkBytes },
          );
          return true;
        });
        if (session.dead.aborted) return;
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

    liveSessions: () => live.size,

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

function isConnectionClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ConnectionClosedError" || error.name === "ConnectionClosingError")
  );
}

/** libp2p's connection keeps its muxer outside the interface; `false` when it cannot tell. */
function muxerClosed(connection: Connection): boolean {
  const status = (connection as { muxer?: { status?: unknown } }).muxer?.status;
  return status != null && status !== "open";
}

function isStreamLimit(error: unknown): boolean {
  return error instanceof Error && error.name === "TooManyOutboundProtocolStreamsError";
}

/** The peer closing a port, as this package names it; anything else as it was. */
function peerClosedPort(error: unknown): unknown {
  return isPeerClosedPort(error)
    ? new MuxPortClosedError("the serving peer closed the exchange's port", { cause: error })
    : error;
}

/**
 * `error` as a reset exchange (`MuxPortClosedError`, mapped to
 * `PeerStreamResetError`) when the mux failed the port because the peer's ack
 * contradicted the presumed one after the port had sent something: the
 * request may have been lost, as on a reset stream. Matched by identity with
 * the port's close reason, so an error the peer sent is never taken for it.
 * The mux lives on and presumes nothing more, so only this exchange fails.
 */
function contradictedPort(error: unknown, closed: AbortSignal | undefined): unknown {
  return error instanceof Error &&
    closed?.aborted === true &&
    closed.reason === error &&
    error.message.startsWith(PRESUMPTION_CONTRADICTED)
    ? new MuxPortClosedError(
        "the serving peer acknowledged the exchange's port otherwise than presumed",
        {
          cause: error,
        },
      )
    : error;
}

function isPeerClosedPort(error: unknown): boolean {
  return error instanceof Error && error.message === PEER_CLOSED_PORT;
}

/**
 * A served exchange's output, whose `return()` (webrun-rpc's teardown of a
 * served stream whose port closed) becomes a `throw()` of the session's
 * `PeerGoneError` when the port closed because the mux died of its peer.
 * webrun-http-streams then abandons the exchange with that error rather than
 * its own "abandoned" one: a handler reading its request body, or watching
 * its request's signal, sees the same `PeerGoneError` as the caller's side.
 *
 * The mux fails its ports before it releases its pipe, which is what marks the
 * session dead, in the same turn; so the check waits one microtask. The
 * teardown itself (cancelling an idle response body) is not delayed beyond it.
 */
function returningAsDeath(
  it: AsyncGenerator<Uint8Array>,
  deathOf: () => unknown,
): AsyncGenerator<Uint8Array> {
  const out = {
    next: (...args: [] | [unknown]) => it.next(...args),
    return: async (value?: unknown): Promise<IteratorResult<Uint8Array>> => {
      await Promise.resolve();
      const death = deathOf();
      if (!(death instanceof PeerGoneError)) return it.return(value as never);
      // The source settles its `throw()` by rethrowing; the teardown asked
      // for a return, and gets one.
      void Promise.resolve(it.throw(death)).catch(() => {});
      return { done: true, value: value as never };
    },
    throw: (error?: unknown) => it.throw(error),
    [Symbol.asyncIterator]() {
      return out;
    },
  };
  return out as unknown as AsyncGenerator<Uint8Array>;
}

/** `input`'s iterator; webrun-rpc hands a served port's input as an async iterable. */
function asyncIteratorOf(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in input) {
    return input[Symbol.asyncIterator]() as AsyncGenerator<Uint8Array>;
  }
  return (async function* () {
    yield* input;
  })();
}

/**
 * `target`, calling `onRelease` when the mux releases it (`close()`): the last
 * thing every close of `multiplexPort` does, whatever closed it, after it
 * failed its ports and in the same turn.
 */
function releasing(target: MessageTarget, onRelease: () => void): MessageTarget {
  return {
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    postMessage: (message, transfer) => target.postMessage(message, transfer),
    get bufferedAmount() {
      return target.bufferedAmount;
    },
    ...(target.whenDrained == null
      ? {}
      : { whenDrained: () => target.whenDrained?.() as Promise<void> }),
    ...(target.start == null ? {} : { start: () => target.start?.() }),
    close: (reason?: unknown) => {
      onRelease();
      return target.close?.(reason);
    },
  };
}

/** @internal What {@link droppingStalledWrites} needs to watch one served port. */
export interface StallWatch {
  rpc: Pick<MuxLibs["rpc"], "getPortCloseSignal" | "portBufferedAmount" | "whenPortReady">;
  port: MessageTarget;
  /** Pieces this size or smaller go out as one message each. */
  pieceBytes: number;
  /** How long one write may stay blocked on the caller. */
  timeoutMs: number;
  /** Called once, when a write stayed blocked for `timeoutMs`. */
  onStall: () => void;
}

/**
 * The handler's output `it`, calling `onStall` once a write of it stays
 * blocked on the caller for `timeoutMs`: the mux path's half of the
 * per-exchange `drainTimeoutMs` contract, which bounds a write the peer does
 * not drain and nothing else.
 *
 * WHAT COUNTS AS BLOCKED. The serving pump pulls the next piece only once the
 * previous one has gone: posted and, past the window, granted credit (or, on a
 * port that does not pipeline, confirmed by the caller). Between a piece
 * handed to the pump and the pump's next pull, the handler is suspended and
 * only the caller can move things on, so that gap is the wait for the caller
 * and nothing else. A handler that is slow to produce (an SSE stream between
 * events, a late response head) is waited on inside `next()`, where no clock
 * runs. Output is split here into pieces that fit one message, so each gap is
 * one message's wait, as the per-exchange path bounds each wait for drain
 * rather than a whole body.
 *
 * ON THE CONFIRMED PATH the gap measures something else. Until the caller has
 * answered the window handshake, webrun-rpc sends each piece as a call that
 * the caller confirms only once its consumer has read past it. A piece sent
 * then is timed by the caller's read speed, not by credit: a caller that reads
 * nothing for `timeoutMs` right at the start of a response is dropped. A
 * caller of this version presumes the ack (webrun-rpc's `presumeAck`) and
 * answers right behind its `open`, so its exchanges never take this path.
 * Nor does any caller's after its mux's first port: from webrun-rpc 0.11 the
 * serving side holds back by the window from the `open` on once it has read a
 * credit on that mux. Only an older caller's first port waits for its
 * answer, about one round trip after the port opens, whether or not it
 * reads, so for an honest caller this lasts that round trip.
 *
 * THE END OF THE STREAM is posted once the output is over, when nothing pulls
 * again. Pipelined (the normal case), it is timed while the port's queue still
 * holds bytes for want of credit; once it has left, the port waits for the
 * caller to read it and end its own direction, which it may take its time
 * over, as a late reader on the per-exchange path may. Sent as a confirmed
 * call instead, the caller never answered the handshake: then neither the
 * confirmation nor the port's release (an `end` is not agreed without the
 * handshake, so only the caller's close frees the port) needs anything but
 * the caller, and the port is closed if it is still open `timeoutMs` later.
 * Without this a caller that withholds its handshake answer, its confirmation
 * and its close keeps the port, counted against `maxInboundStreams`, for as
 * long as the mux lives.
 *
 * One timer serves every wait: arming notes when the wait began, and the timer
 * re-checks when it fires, so a piece costs a clock read rather than a timer
 * set and cleared. A stall is still caught `timeoutMs` (plus up to one timer
 * slip) after its wait began. The timer is cleared when the output ends any
 * way, or when the port closes; after a wait that ended, it fires at most
 * once more, finds nothing to time and stops.
 *
 * @internal Exported for its tests only; not part of the package's API.
 */
export function droppingStalledWrites(
  it: AsyncGenerator<Uint8Array>,
  { rpc, port, pieceBytes, timeoutMs, onStall }: StallWatch,
): AsyncGenerator<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the current wait on the caller began; `undefined` while none runs. */
  let blockedSince: number | undefined;
  let over = false;
  const portClosed = rpc.getPortCloseSignal(port);
  /** The wait ended. The timer, if any, stays: it finds no wait and stops. */
  const disarm = () => {
    blockedSince = undefined;
  };
  const finish = () => {
    over = true;
    blockedSince = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    portClosed?.removeEventListener("abort", finish);
  };
  portClosed?.addEventListener("abort", finish, { once: true });
  if (portClosed?.aborted) finish();
  // The end sent as a confirmed call (see above): spotted where the pump posts
  // it, by webrun-rpc's call shape on the handler's channel (`out`).
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  const clearEnd = () => {
    if (endTimer !== undefined) clearTimeout(endTimer);
    endTimer = undefined;
  };
  const target = port as { postMessage(message: unknown, ...rest: unknown[]): void };
  const post = target.postMessage;
  target.postMessage = function (this: unknown, message: unknown, ...rest: unknown[]) {
    const sent = message as
      | { type?: unknown; channelName?: unknown; params?: { done?: unknown } }
      | undefined;
    if (
      endTimer === undefined &&
      portClosed != null &&
      !portClosed.aborted &&
      sent?.type === "request" &&
      sent.channelName === "out" &&
      sent.params?.done === true
    ) {
      portClosed.addEventListener("abort", clearEnd, { once: true });
      endTimer = setTimeout(() => {
        endTimer = undefined;
        portClosed.removeEventListener("abort", clearEnd);
        finish();
        onStall();
      }, timeoutMs);
    }
    return post.call(this, message, ...rest);
  };
  const arm = () => {
    if (over) return;
    blockedSince = performance.now();
    if (timer === undefined) timer = setTimeout(check, timeoutMs);
  };
  /**
   * One timer for many waits: a wait that ended (`blockedSince` cleared) or
   * began after the timer was set leaves it to re-check later, rather than
   * each piece setting and clearing a timer of its own.
   */
  const check = (): void => {
    timer = undefined;
    if (over || blockedSince === undefined) return;
    const waited = performance.now() - blockedSince;
    if (waited < timeoutMs) {
      timer = setTimeout(check, timeoutMs - waited);
      return;
    }
    finish();
    onStall();
  };
  /**
   * After the output is over: on a later task (the pump posts the last piece
   * and the end in the turns after `done`), and again each time the queue
   * drains, a queue that still holds bytes for want of credit runs the clock.
   */
  const watchTail = (): void => {
    setTimeout(() => {
      if (over) return;
      if (rpc.portBufferedAmount(port) === 0) {
        finish();
        return;
      }
      arm();
      void rpc.whenPortReady(port).then(() => {
        disarm();
        watchTail();
      });
    }, 0);
  };
  /** The rest of the current block, still to hand out in pieces. */
  let rest: Uint8Array | undefined;
  const piece = (): IteratorResult<Uint8Array> => {
    const block = rest as Uint8Array;
    const value = block.byteLength > pieceBytes ? block.subarray(0, pieceBytes) : block;
    rest = block.byteLength > pieceBytes ? block.subarray(pieceBytes) : undefined;
    // Handed to the pump: until it pulls again, it waits on the caller.
    arm();
    return { done: false, value };
  };
  const out = {
    next: async (...args: [] | [unknown]): Promise<IteratorResult<Uint8Array>> => {
      // The pump pulled: the previous piece has gone.
      disarm();
      if (rest !== undefined) return piece();
      let result: IteratorResult<Uint8Array>;
      try {
        result = await it.next(...args);
      } catch (error) {
        // The error goes out as the end of the stream, like a last piece.
        watchTail();
        throw error;
      }
      if (result.done) {
        watchTail();
        return result;
      }
      rest = result.value;
      return piece();
    },
    return: (value?: unknown) => {
      finish();
      rest = undefined;
      return it.return(value as never);
    },
    throw: (error?: unknown) => {
      finish();
      rest = undefined;
      return it.throw(error);
    },
    [Symbol.asyncIterator]() {
      return out;
    },
  };
  return out as unknown as AsyncGenerator<Uint8Array>;
}

/**
 * `it`, calling `onAbnormal` once if it ends any way but by finishing: a
 * `return()` or `throw()` from its consumer, or a rejection. Like
 * {@link mappingErrors}, a plain object, so `return()` reaches `it` at once.
 */
function onAbnormalEnd(
  it: AsyncGenerator<Uint8Array>,
  onAbnormal: () => void,
): AsyncGenerator<Uint8Array> {
  let settled = false;
  const abnormal = () => {
    if (settled) return;
    settled = true;
    onAbnormal();
  };
  const out = {
    next: async (...args: [] | [unknown]) => {
      try {
        const result = await it.next(...args);
        if (result.done) settled = true;
        return result;
      } catch (error) {
        abnormal();
        throw error;
      }
    },
    return: (value?: unknown) => {
      abnormal();
      return it.return(value as never);
    },
    throw: (error?: unknown) => {
      abnormal();
      return it.throw(error);
    },
    [Symbol.asyncIterator]() {
      return out;
    },
  };
  return out as unknown as AsyncGenerator<Uint8Array>;
}

/**
 * `it`, with each rejection passed through `map`. A plain object rather than
 * an async generator around `it`, so `return()` still reaches `it` at once
 * while a `next()` is pending (an async generator would queue it behind).
 */
function mappingErrors(
  it: AsyncGenerator<Uint8Array>,
  map: (error: unknown) => unknown,
): AsyncGenerator<Uint8Array> {
  const mapped = <T>(p: Promise<T>): Promise<T> =>
    p.catch((error: unknown) => {
      throw map(error);
    });
  const out = {
    next: (...args: [] | [unknown]) => mapped(it.next(...args)),
    return: (value?: unknown) => mapped(it.return(value as never)),
    throw: (error?: unknown) => mapped(it.throw(error)),
    [Symbol.asyncIterator]() {
      return out;
    },
  };
  const dispose = (Symbol as { asyncDispose?: symbol }).asyncDispose;
  if (dispose != null) {
    (out as Record<symbol, unknown>)[dispose] = async () => {
      await out.return();
    };
  }
  return out as unknown as AsyncGenerator<Uint8Array>;
}
