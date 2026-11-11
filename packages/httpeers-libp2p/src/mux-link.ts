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
 *     one: reconnection is just the next call.
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
 * more than 16 KiB on loopback (`scripts/bench-mux.mjs`, #56). Two such
 * frames still fit one coalesced write (`mux-target.ts`), one Noise message.
 * And a frame plus its envelope stays within 32 KiB, the largest message a
 * build on the earlier (unreleased) 16 KiB default accepts (`frameSize +
 * MUX_MESSAGE_HEADROOM`), so such a peer still reads what this side sends.
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
    const { target, signal } = muxTargetOverStream(stream, { maxMessageBytes });
    const dead = new AbortController();
    const mux = libs.rpc.multiplexPort(target as unknown as MessageTarget, {
      codec: libs.codec,
      side,
      window: windowBytes,
      frameSize,
      maxReassembledBytes,
      maxPorts,
      maxMessageSize: maxChunkBytes,
      ...(keepaliveMs > 0 ? { keepalive: { intervalMs: keepaliveMs } } : {}),
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
    const onStreamGone = () => {
      dead.abort(signal.reason);
    };
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
      void session.close(new PeerGoneError()).catch(() => {});
    }
    return session;
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
        call: ((input: AsyncIterable<Uint8Array>) =>
          mappingErrors(duplex(input), peerClosedPort)) as Duplex,
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
                droppingStalledWrites(handler(input), {
                  rpc: libs.rpc,
                  port,
                  pieceBytes: maxChunkBytes,
                  timeoutMs: init.drainTimeoutMs,
                  onStall: () => {
                    closePort();
                    void output.return(undefined).catch(() => {});
                  },
                }),
                closePort,
              );
              return output;
            },
            { maxMessageSize: maxChunkBytes },
          );
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

function isStreamLimit(error: unknown): boolean {
  return error instanceof Error && error.name === "TooManyOutboundProtocolStreamsError";
}

/** The peer closing a port, as this package names it; anything else as it was. */
function peerClosedPort(error: unknown): unknown {
  return error instanceof Error && error.message === PEER_CLOSED_PORT
    ? new MuxPortClosedError("the serving peer closed the exchange's port", { cause: error })
    : error;
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
 * answered the window handshake (about one round trip after the port opens),
 * webrun-rpc sends each piece as a call that the caller confirms only once its
 * consumer has read past it. A piece sent then is timed by the caller's read
 * speed, not by credit: a caller that reads nothing for `timeoutMs` right at
 * the start of a response is dropped. A caller answers the handshake whether
 * or not it reads, so this lasts one round trip for an honest one.
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
    blockedSince = Date.now();
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
    const waited = Date.now() - blockedSince;
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
