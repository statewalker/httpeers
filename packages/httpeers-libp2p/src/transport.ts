/**
 * The transport adapter. THE ONLY FILE IN THIS PACKAGE THAT IMPORTS libp2p —
 * verify with `grep -rlE "^import.*libp2p" src/` from the package root; it
 * must list only this file. That constraint is what keeps the transport
 * swappable: everything else in `httpeers.core` talks `FetchHandler`
 * (`Request -> Promise<Response>`) and never sees a `Stream` or a
 * `Connection`.
 *
 * IDENTITY BY CLOSURE (note 24). `Duplex = (input) => AsyncGenerator` is one
 * parameter, deliberately, with no slot for identity — hiding the transport
 * is what makes `Duplex` swappable. So the serving-side `Duplex` is built PER
 * INBOUND STREAM, with the proven peer captured in that build's closure, and
 * `registerPeer` runs from inside it before `dispatch` ever sees the
 * `Request`. `serveConnections` (from `@statewalker/webrun-streams-libp2p`)
 * exists for exactly this: it calls back once per stream with a
 * `ConnectionContext` carrying `remotePeer` — the peer id libp2p's Noise
 * handshake proved for that connection, the one identity claim on the
 * serving side nothing in the request payload can forge.
 *
 * `serveConnections` is used here rather than registering the protocol by
 * hand (`node.handle`), because it already threads `ConnectionContext`
 * through and owns the serving-side input queue / backpressure handling
 * (`duplexOverStream`) a hand port would have to reimplement.
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
// Re-exported so `peer.ts` (and any other consumer) can type an already-
// constructed node, or a retained signing key, without itself importing
// `@libp2p/interface` — this file stays the only one that does.
export type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { fetchOverDuplex, HttpParseError, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, type ConnectionContext, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import {
  PeerCallError,
  PeerProtocolUnsupportedError,
  PeerRelayLimitExceededError,
  PeerRequestTimeoutError,
  PeerStreamResetError,
  PeerUnreachableError,
  UnknownPeerCallError,
} from "@statewalker/httpeers-core";
import { registerPeer } from "@statewalker/httpeers-core";
import type { FetchHandler, PeerIdStr, Remote } from "@statewalker/httpeers-core";

/**
 * A namespaced protocol id, passed explicitly rather than left at
 * `webrun-streams-libp2p`'s package default (`/webrun-streams/1.0.0`). The
 * protocol id is the demux key libp2p uses to route an inbound stream to a
 * handler on the node: sharing the generic default would collide with any
 * other `webrun-streams` consumer sharing the same libp2p node.
 */
export const PROTOCOL = "/httpeers/1.0.0";

/**
 * Per-connection concurrent stream cap, applied to both directions — THE
 * SERVER-SIDE CONTRACT (ledger note 18 §6, T-3/Task 18 step 3): libp2p's own
 * default is 32 inbound / 64 outbound streams per protocol per connection;
 * past the inbound number, a new stream is RESET, not queued, and the caller
 * observes that reset as `PeerStreamResetError` (`kind: "stream-reset"`,
 * `errors.ts` row 3b, `mapPeerCallError`'s `TooManyInboundProtocolStreamsError`
 * branch) — never a raw libp2p exception, but still a rejected call with no
 * retry or backoff of its own. 512 is the recorded precedent from the
 * stream-limits task (6a) and its regression tests in
 * `webrun-streams-libp2p`. Raising it moves this cliff outward; it does not
 * remove it, which is why `DEFAULT_MAX_CONCURRENT_OUTBOUND` below exists —
 * see that constant's doc comment for the client-side half of this contract.
 *
 * THE EXPOSURE WINDOW this cap forms together with `DEFAULT_DRAIN_TIMEOUT_MS`
 * (the OTHER half of the same contract, Task 18 step 3): a peer that opens
 * every one of its 512 allowed streams and then stops reading pins
 * `DEFAULT_MAX_STREAMS * DEFAULT_DRAIN_TIMEOUT_MS` = 512 * 15s ≈ 2.1
 * stream-hours of this node's buffer before the last one is dropped. See
 * `DEFAULT_DRAIN_TIMEOUT_MS`'s own doc comment for why 15s (not
 * `webrun-streams-libp2p`'s 5-minute default) was chosen once this cap was
 * raised past libp2p's own default. Both numbers are stated here as ONE
 * contract, not two independently-tunable knobs: changing either without
 * re-deriving this product reopens a cliff of a different shape.
 */
export const DEFAULT_MAX_STREAMS = 512;

/**
 * How long a served stream waits for a backpressured peer to drain before
 * being dropped. This is the ONLY bound on a peer that requests something
 * and then stops reading without closing — the serving side has no
 * `.return`/abort escape the way `connect`'s caller side does.
 *
 * It multiplies with `DEFAULT_MAX_STREAMS`: a peer that opens the full
 * stream cap and never reads any of them pins `DEFAULT_MAX_STREAMS *
 * drainTimeoutMs` stream-milliseconds of server-side buffer before every one
 * of them is finally dropped. `webrun-streams-libp2p`'s own default (5
 * minutes) times a 512-stream cap is ~42.7 stream-hours of exposure — too
 * generous to leave in force once the cap itself has been raised well past
 * libp2p's default. 15 seconds is chosen instead: long enough that a
 * legitimate reader on a slow or lossy link still has room to drain a
 * response chunk (multiple seconds of headroom even at very low bandwidth),
 * short enough that the worst case — every one of 512 streams held open by a
 * peer that never reads — caps out at 512 * 15s ≈ 2.1 stream-hours and clears
 * within one operational window rather than requiring intervention.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

/**
 * T-2's request timeout contract: how long `Peer.call()` / `Remote` wait —
 * across queueing for a local concurrency slot (T-3/Task 18, see
 * `DEFAULT_MAX_CONCURRENT_OUTBOUND` below), dialing, protocol negotiation,
 * and the response itself — before giving up and rejecting with
 * `PeerRequestTimeoutError`. This is a CONTRACT, not a tuning knob picked in
 * isolation: no caller of this package may assume an unbounded wait for a
 * response, ever, and this is the number that bounds it by default.
 *
 * T-3 DELIBERATELY DID NOT ADD A SEPARATE QUEUE TIMEOUT. When Task 18 added
 * the outbound semaphore, the queue wait it introduces was placed INSIDE
 * this same race rather than behind its own timer — see
 * `DEFAULT_MAX_CONCURRENT_OUTBOUND`'s doc comment for the reasoning and the
 * worst-case arithmetic that decision avoids.
 *
 * CHOSEN BELOW `DEFAULT_DRAIN_TIMEOUT_MS` (15s) AND `PROTOCOL_NEGOTIATION_TIMEOUT`
 * (10s, libp2p's own default for how long protocol negotiation may take —
 * `libp2p/dist/src/connection-manager/constants.defaults.js`), deliberately:
 * 8s < 10s < 15s. That ordering means THIS timeout is always the first bound
 * to trip. A caller therefore always observes a typed
 * `PeerRequestTimeoutError` for any hang, never a raw libp2p `TimeoutError`
 * leaking through from the negotiation phase, and the drain timeout exists
 * purely as a transport-internal safety net most requests will never reach.
 * The reverse ordering — a request timeout longer than the drain timeout —
 * would mean the transport gives up on a stalled response before the
 * caller's own timeout ever fires, which is a coherent choice only when
 * deliberate; it is not the choice made here.
 *
 * 8 seconds: generous enough that an ordinary handler (token verification,
 * a store lookup, one hop through a relay) never trips it under normal
 * load, short enough that a caller waiting on a mesh peer notices "this
 * peer is not answering" within under two heartbeat intervals (the
 * heartbeat cadence this design assumes is 5s — see `DEFAULT_MINT_TTL_MS`'s
 * doc comment in `peer.ts`) rather than being left hanging indefinitely.
 * Override via `requestTimeoutMs` when a deployment knows better.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

/**
 * T-3 (Task 18): the CLIENT-SIDE half of the concurrency contract
 * `DEFAULT_MAX_STREAMS` states the server-side half of. Ledger note 18 §6 is
 * explicit that raising `maxInboundStreams`/`maxOutboundStreams` to 512
 * (Task 6a) MOVED the cliff rather than removing it: past the cap, libp2p
 * RESETS the stream instead of queueing it, so a caller sees a rejected
 * promise instead of latency, and nothing retries or backs off. This
 * constant bounds `createRemote`'s own concurrency instead, so a well-behaved
 * `Remote` never has to find that cliff at all: `createRemote` runs every
 * outbound call through a private, in-process semaphore of this width before
 * it ever calls `connect()` (which is what triggers libp2p's own
 * `maxOutboundStreams` check, `TooManyOutboundProtocolStreamsError` --
 * `errors.ts` row 3a). Excess calls QUEUE, in FIFO order, rather than racing
 * each other into that cap.
 *
 * DEFAULTED TO `DEFAULT_MAX_STREAMS`, NOT SOME OTHER NUMBER, DELIBERATELY:
 * this is a per-`Remote` (i.e. per-`Peer`) budget, not per-target-peer, so a
 * `Peer` that only ever calls ONE target sees IDENTICAL admitted concurrency
 * to before -- it will now queue instead of reset at the same threshold,
 * never tighter -- while a `Peer` fanning calls out to MANY targets at once
 * (a relay/hub forwarding on behalf of several callers) gets an additional,
 * new global ceiling on its own total outbound fan-out that did not exist
 * before this task. That second effect is intentional: `DEFAULT_MAX_STREAMS`
 * is a PER-CONNECTION cap, so nothing previously bounded how many
 * connections' worth of streams one `Remote` could have open at once: a
 * `Peer` calling 20 different targets at 512 streams apiece could reach
 * 10,240 concurrent outbound streams without ever touching any single
 * connection's cap. That is exactly the kind of local resource exhaustion a
 * DoS-adjacent control (see `DEFAULT_MAX_STREAMS`'s own doc comment) should
 * not leave open just because it happens to fan out across many peers
 * instead of one.
 *
 * THE AT-LIMIT CONTRACT (the decision ledger note 18 §6 left open --
 * "queue, reject fast, or apply backpressure to the caller"): QUEUE, with a
 * BOUNDED wait, then REJECT with a typed error from Task 17's taxonomy --
 * never a silent reset (that would just be `DEFAULT_MAX_STREAMS`'s cliff
 * again, moved one layer up), and never an unbounded queue (an unfailing
 * queue under sustained overload is a slow-motion version of the same
 * failure the timeout policy already rules out for every other kind of
 * hang). Concretely: the bound is `DEFAULT_REQUEST_TIMEOUT_MS`, not a
 * second, independent timer. `createRemote`'s `withRequestTimeout` race
 * already covers "dial, negotiate, respond"; queueing for a `Semaphore`
 * permit is placed INSIDE that same race (before `connect()` is even
 * called), not layered outside it, specifically so a queued call that never
 * gets a permit rejects with the SAME `PeerRequestTimeoutError` an
 * unresponsive peer would produce, and within the SAME bound. The
 * alternative -- a queue timeout on top of the existing request timeout --
 * was considered and rejected: a caller that waits `requestTimeoutMs` in the
 * queue and then gets a fresh `requestTimeoutMs` for the call itself sees up
 * to 2 * `DEFAULT_REQUEST_TIMEOUT_MS` (16s) worst case, silently doubling a
 * contract Task 17 wrote down as an 8-second promise. Sharing one budget
 * keeps that promise: `Peer.call()` / `Remote` never wait longer than
 * `requestTimeoutMs` for ANY reason, queueing included. Whichever reason
 * wins the race, `mapPeerCallError`'s `if (err instanceof PeerCallError)
 * return err` passes it through unchanged, so this never becomes a new
 * taxonomy row -- `PeerRequestTimeoutError`'s trigger set simply grows to
 * include "gave up waiting for a local concurrency slot," alongside its
 * existing "gave up waiting for a response."
 *
 * A held permit is released in a `finally` (see `createRemote`) regardless
 * of how the call ends -- success, a mapped `PeerCallError`, or the timeout
 * race itself -- so one failing call can never permanently strand a slot.
 */
export const DEFAULT_MAX_CONCURRENT_OUTBOUND = DEFAULT_MAX_STREAMS;

/**
 * A minimal FIFO counting semaphore -- `acquire()` resolves immediately
 * while a permit is free, otherwise queues the caller until `release()` (or
 * an earlier grant to it) frees one. Not exported: this is `createRemote`'s
 * own T-3 admission control, not a general-purpose utility this package
 * offers callers -- see `DEFAULT_MAX_CONCURRENT_OUTBOUND`'s doc comment for
 * the contract it implements.
 *
 * `acquire(signal)` accepts an `AbortSignal` so a queued (not yet granted)
 * wait can be cancelled -- `createRemote` aborts it from the SAME
 * `onTimeout` callback that already cancels a partially-opened stream, so a
 * call that loses the `requestTimeoutMs` race while still queued stops
 * waiting immediately rather than eventually consuming a permit nothing will
 * ever release.
 */
class Semaphore {
  #available: number;
  readonly #waiting: Array<{ grant: () => void }> = [];

  constructor(width: number) {
    this.#available = width;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(() => this.#release());
        },
      };
      const onAbort = (): void => {
        const index = this.#waiting.indexOf(waiter);
        // Already granted (removed from the queue, permit handed out) --
        // the abort lost the race; nothing to cancel, the caller must
        // release the permit it already has instead.
        if (index === -1) return;
        this.#waiting.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) {
      next.grant();
    } else {
      this.#available++;
    }
  }
}

/**
 * Node.js `net`'s own connection-establishment errno codes -- structured,
 * documented properties (`err.code`), never a message string. Needed
 * because of a finding this file's own tests turned up (see the Task 17
 * report): libp2p's dial queue (`dial-queue.js`'s `dialPeer`) wraps
 * PER-ADDRESS failures in `AggregateError` only when MORE THAN ONE address
 * was tried (`errors.push(err)`, then `new AggregateError(errors, ...)`).
 * With exactly one address -- the common case for an httpeers peer, which
 * usually has one listen address -- it does `if (errors.length === 1) throw
 * errors[0]`: the RAW error from `@libp2p/tcp`'s `net.connect` escapes
 * unwrapped, with no distinguishing class or `.name` at all (`.name` is
 * plain `"Error"`). `@libp2p/tcp` (`tcp.js`'s `_connect`) only prefixes that
 * error's `.message`; it does not touch `.code`, so Node's own errno is
 * still there to check instead of parsing text.
 */
const CONNECTION_ESTABLISHMENT_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

/**
 * Map whatever a failed dial/call/timeout actually threw onto this
 * package's own taxonomy (`errors.ts`), so `Peer.call()` / `Remote` keep
 * the contract "you get a `PeerCallError`, never a raw transport
 * exception". Exported so a future transport adapter (or a test) can see
 * exactly which condition maps to which class; see each class's own doc
 * comment in `errors.ts` for the library source each case is grounded in.
 *
 * Matched by `.name` string, not `instanceof`, for three of the cases
 * below (`NoValidAddressesError`, `DialError`/`DialDeniedError`,
 * `TransferLimitError`): none is part of `@libp2p/interface`'s (or any
 * dependency this package actually has) public export surface, so there is
 * no class to import and compare against. `.name` is reliably set on the
 * *instance*, not only the `static name`, in every libp2p error class this
 * was checked against (`@libp2p/interface/dist/src/errors.js`,
 * `libp2p/dist/src/errors.js`), which is what makes the string check sound
 * rather than a guess.
 */
export function mapPeerCallError(err: unknown, peerId: PeerIdStr): PeerCallError {
  if (err instanceof PeerCallError) return err; // already mapped (e.g. re-thrown by a timeout race)

  const name = err instanceof Error ? err.name : undefined;
  const code = (err as { code?: unknown } | undefined)?.code;
  const cause = { cause: err };

  // "All multiaddr dials failed" -- thrown only when 2+ addresses were
  // tried and every one failed; see `CONNECTION_ESTABLISHMENT_ERRNO`'s doc
  // comment above for the single-address case, which does NOT go through
  // this class. `AggregateError` is a JS built-in, so this is the one case
  // checked by `instanceof` rather than `.name`.
  if (err instanceof AggregateError) return new PeerUnreachableError(peerId, cause);

  // The single-address unwrap: a raw Node.js connection error with no
  // libp2p class or name of its own, identified by its own errno.
  if (typeof code === "string" && CONNECTION_ESTABLISHMENT_ERRNO.has(code)) {
    return new PeerUnreachableError(peerId, cause);
  }

  // A `HttpParseError` (`@statewalker/webrun-http-streams`) specifically
  // for "no bytes arrived at all" is this package's own transport-and-codec
  // stack's OTHER real signature of a stream reset, discovered by running
  // this file's own tests (Task 17 report has the trace): when the
  // server-side stream is aborted (a concurrency-cap reset, or any other
  // abort) before a single response byte was written, the client-side
  // codec's format sniffer (`sniff.ts`) sees end-of-stream on its very
  // first read and throws this, rather than any stream-level error class
  // ever reaching this far up the stack. `duplexOverStream`
  // (`webrun-streams-libp2p`) does not distinguish a reset from a clean
  // early close at its own layer, so this message is the only signal left
  // by the time it gets here -- narrowed to this exact `sniff.ts` message
  // (not every `HttpParseError`) because a genuinely malformed response
  // (a foreign codec, corrupted bytes) is a different, real condition this
  // must not misclassify as a reset.
  if (err instanceof HttpParseError && err.message.includes("stream ended before any bytes arrived")) {
    return new PeerStreamResetError(peerId, cause);
  }

  switch (name) {
    // No dialable address is known for this peerId at all (never connected,
    // no peer routing configured), or our own dial queue/gater refused to
    // try -- libp2p/dist/src/connection-manager/dial-queue.js.
    case "NoValidAddressesError":
    case "DialError":
    case "DialDeniedError":
      return new PeerUnreachableError(peerId, cause);
    // multistream-select could not agree on a protocol -- @libp2p/interface,
    // thrown from @libp2p/multistream-select's select().
    case "UnsupportedProtocolError":
      return new PeerProtocolUnsupportedError(peerId, PROTOCOL, cause);
    // A remote reset, a local abort, or our own outbound stream cap tripped
    // inside libp2p's Connection#newStream, rejecting before the stream is
    // handed back rather than queueing it -- @libp2p/interface. CORRECTED
    // ON REVIEW (Task 18): this is an async rejection (the throw happens
    // after `await mss.select(...)` inside `newStream`'s own async body,
    // `connection.js:118` in `libp2p@3.3.8`), not a synchronous throw
    // escaping outside a promise chain -- see `PeerStreamResetError`'s doc
    // comment in `errors.ts` (row 3a) for why that distinction matters here
    // specifically.
    case "StreamResetError":
    case "StreamAbortedError":
    case "TooManyOutboundProtocolStreamsError":
    case "TooManyInboundProtocolStreamsError":
      return new PeerStreamResetError(peerId, cause);
    // @libp2p/circuit-relay-v2's relay-side byte-limit enforcement. See
    // `PeerRelayLimitExceededError`'s doc comment: grounded, but unwired
    // and untested in this stack -- this package has no relay transport.
    case "TransferLimitError":
      return new PeerRelayLimitExceededError(peerId, cause);
    // libp2p's own internal timeouts (protocol negotiation, connection
    // close) -- @libp2p/interface. Reached only if this package's own
    // (shorter) DEFAULT_REQUEST_TIMEOUT_MS race somehow did not win, which
    // should not happen given the ordering documented on that constant, but
    // mapping it here rather than falling through to UnknownPeerCallError
    // keeps the contract honest either way.
    case "TimeoutError":
      return new PeerRequestTimeoutError(peerId, DEFAULT_REQUEST_TIMEOUT_MS, cause);
    default:
      return new UnknownPeerCallError(peerId, cause);
  }
}

/**
 * Race `attempt()` against `timeoutMs`. On timeout, calls `onTimeout()` for
 * best-effort cleanup (closing whatever streams a partially-established
 * call already opened, and -- T-3/Task 18 -- aborting a still-queued
 * `Semaphore` wait so it does not later consume a permit nobody will
 * release) and rejects with `PeerRequestTimeoutError`.
 *
 * KNOWN LIMITATION, stated rather than silently accepted: `connect()`
 * (`@statewalker/webrun-streams-libp2p`) accepts no `AbortSignal` for the
 * dial itself, so a timeout that fires WHILE `connect()` is still dialing
 * cannot cancel that dial -- `onTimeout` has nothing to close yet in that
 * interleaving, and the underlying `node.dialProtocol` call is abandoned
 * rather than aborted. It still eventually settles (libp2p has its own
 * internal dial/negotiation timeouts) and its result is discarded either
 * way; this bounds what the CALLER waits for, not what the underlying
 * dial does after the caller has stopped waiting. Fixing that would mean
 * changing `connect()`'s signature in `webrun-streams-libp2p`, a different
 * fragment this task does not touch (see the Task 17 report).
 */
async function withRequestTimeout<T>(
  attempt: () => Promise<T>,
  timeoutMs: number,
  peerId: PeerIdStr,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new PeerRequestTimeoutError(peerId, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateNodeInit {
  /**
   * Multiaddrs to listen on. Omit (or pass an empty array) for a dial-only
   * node — one that can call out but accepts no inbound connections, which
   * is a legitimate deployment shape (a client-only edge peer).
   */
  listen?: string[];
  /**
   * The node's own signing key. Omit to let libp2p generate one internally
   * — fine for a peer that never needs to prove that key again once the
   * node exists. `createPeer` generates and RETAINS this key itself (never
   * here) when it needs to mint tokens later, because `createLibp2p` never
   * hands a generated key back out; if the caller doesn't keep the
   * reference before calling this function, it is gone for good.
   */
  privateKey?: Ed25519PrivateKey;
  /**
   * The libp2p transports this node speaks. **Required, and deliberately so.**
   *
   * The prototype hard-coded `tcp()` here, which made importing this module at
   * all pull a Node-only transport into a browser bundle — in a package whose
   * root export is supposed to run on both. There is no sensible default: a
   * server wants `tcp()`, a page wants `webRTC()` and `webSockets()`, and
   * guessing produces a node that cannot dial anything on the platform it
   * actually ran on.
   *
   * `./node` and `./browser` supply the profiles; this stays platform-free.
   */
  transports: TransportFactory[];
  /**
   * Extra libp2p services — `circuitRelayServer()` for a hub, say. Merged
   * over the `identify` this always registers.
   */
  services?: Record<string, unknown>;
  /** A connection gater, e.g. membership. */
  connectionGater?: unknown;
}

/**
 * A libp2p transport factory — `tcp()`, `webSockets()`, `webRTC()`.
 *
 * Typed loosely on purpose: naming libp2p's `Transport` here would drag the
 * whole interface package into the signature for no gain, and every caller
 * passes the result of a factory it already imported.
 */
export type TransportFactory = (components: never) => unknown;

/**
 * Build a libp2p node with the transport stack this package's tests and
 * `createPeer`'s default construction path both rely on: TCP, Noise
 * (connection encryption — this is what makes `ConnectionContext.remotePeer`
 * trustworthy), Yamux (stream muxing) and identify (address exchange, so a
 * peer dialled once by full multiaddr can be dialled again by bare peerId —
 * see `createRemote`). Not the only file allowed to build a node makes this
 * package's swappable-transport claim false, so this stays inside
 * `transport-duplex.ts`; `peer.ts` calls it, never `createLibp2p` directly.
 */
export async function createNode(init: CreateNodeInit): Promise<Libp2p> {
  const { listen = [], privateKey, transports, services, connectionGater } = init;
  if (transports.length === 0) {
    throw new TypeError(
      "createNode: at least one transport is required. Use `nodeTransports()` from " +
        "`@statewalker/httpeers-libp2p/node` or `browserTransports()` from `./browser`.",
    );
  }
  return createLibp2p({
    ...(privateKey != null ? { privateKey } : {}),
    ...(connectionGater != null ? { connectionGater } : {}),
    addresses: { listen },
    // biome-ignore lint/suspicious/noExplicitAny: libp2p's own factory types are
    // not expressible without importing its whole component graph.
    transports: transports as any,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ...(services ?? {}) } as never,
  });
}

export interface ServeTransportInit {
  node: Libp2p;
  /** The composed peer router — everything downstream of identity. */
  dispatch: FetchHandler;
  /** Defaults to `PROTOCOL`. */
  protocol?: string;
  /** Defaults to `DEFAULT_DRAIN_TIMEOUT_MS`. See that constant's doc comment. */
  drainTimeoutMs?: number;
  /** Defaults to `DEFAULT_MAX_STREAMS`. See that constant's doc comment. */
  maxInboundStreams?: number;
  /** Defaults to `DEFAULT_MAX_STREAMS`. See that constant's doc comment. */
  maxOutboundStreams?: number;
}

/**
 * Register the httpeers protocol handler on `node`. Every inbound stream
 * gets its own `Duplex`, closing over that stream's proven `remotePeer` —
 * `registerPeer` runs before `dispatch` is ever called, so every handler
 * downstream (the binding middleware first) sees the identity the transport
 * itself proved, never anything the peer merely claims.
 *
 * Returns the teardown function `serveConnections` itself returns
 * (`node.unhandle` for this protocol).
 */
export async function serveTransport(init: ServeTransportInit): Promise<() => Promise<void>> {
  const {
    node,
    dispatch,
    protocol = PROTOCOL,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxInboundStreams = DEFAULT_MAX_STREAMS,
    maxOutboundStreams = DEFAULT_MAX_STREAMS,
  } = init;
  return serveConnections(
    { node, protocol, drainTimeoutMs, maxInboundStreams, maxOutboundStreams },
    (context: ConnectionContext) => {
      const peerId = context.remotePeer.toString();
      return serveFetchOverDuplex(async (req) => {
        registerPeer(req, peerId);
        return dispatch(req);
      });
    },
  );
}

export interface CreateRemoteInit {
  node: Libp2p;
  /** Defaults to `PROTOCOL`. */
  protocol?: string;
  /** Defaults to `DEFAULT_DRAIN_TIMEOUT_MS`. See that constant's doc comment. */
  drainTimeoutMs?: number;
  /**
   * Defaults to `DEFAULT_MAX_STREAMS`. Set here too, not only on the serving
   * side: a peer both serves and dials (a relay forwards by dialing out), so
   * the outbound cap needs the same headroom as the inbound one.
   */
  maxOutboundStreams?: number;
  /**
   * Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. See that constant's doc
   * comment for the value, the contract it states, and its relationship to
   * `drainTimeoutMs`.
   */
  requestTimeoutMs?: number;
  /**
   * T-3 (Task 18): the width of this `Remote`'s outbound admission
   * semaphore. Defaults to `DEFAULT_MAX_CONCURRENT_OUTBOUND`. See that
   * constant's doc comment for the full contract -- what "width" bounds
   * (this `Remote`'s total in-flight calls, across every target peer, not
   * per-connection), and why queueing past it shares `requestTimeoutMs`
   * rather than getting its own timer.
   */
  maxConcurrentOutbound?: number;
}

/**
 * Build the `Remote` seam `createPeerRouter` forwards through: dial `target`
 * over libp2p and run the request over the resulting `Duplex`. Outbound is
 * definitionally identity-free — nothing here registers a peer binding,
 * because the *caller's* proven identity has no meaning on a connection *we*
 * initiated.
 *
 * Every rejection from the returned function is a `PeerCallError` (see
 * `errors.ts` and `mapPeerCallError` above) — never a raw libp2p exception,
 * and never an unbounded wait: the whole queue-dial-negotiate-respond
 * sequence (T-3/Task 18 added the queueing step) is raced against
 * `requestTimeoutMs`.
 *
 * ONE `Semaphore` PER `Remote`, NOT PER CALL: `createRemote` is called once
 * per `Peer` (see `peer.ts`'s `createPeer`), so the semaphore built here is
 * that peer's single, shared outbound admission gate for as long as the
 * `Peer` lives -- every call through this `Remote`, to every target,
 * competes for the same `maxConcurrentOutbound` permits. See
 * `DEFAULT_MAX_CONCURRENT_OUTBOUND`'s doc comment for why that scope (global
 * to this `Remote`, not per-target-peer) was chosen.
 */
export function createRemote(init: CreateRemoteInit): Remote {
  const {
    node,
    protocol = PROTOCOL,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxOutboundStreams = DEFAULT_MAX_STREAMS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxConcurrentOutbound = DEFAULT_MAX_CONCURRENT_OUTBOUND,
  } = init;
  const semaphore = new Semaphore(maxConcurrentOutbound);
  return async (target: PeerIdStr, req: Request): Promise<Response> => {
    let opened: { close: () => Promise<void> } | undefined;
    // Ties a still-queued `Semaphore.acquire()` wait to the SAME timeout
    // that already bounds this whole call -- see `onTimeout` below and
    // `DEFAULT_MAX_CONCURRENT_OUTBOUND`'s doc comment for why there is no
    // second, independent queue timer.
    const abortQueue = new AbortController();
    try {
      return await withRequestTimeout(
        async () => {
          const release = await semaphore.acquire(abortQueue.signal);
          try {
            const conn = await connect({
              node,
              peer: multiaddr(`/p2p/${target}`),
              protocol,
              drainTimeoutMs,
              maxOutboundStreams,
            });
            opened = conn;
            return await fetchOverDuplex(conn.call, req);
          } finally {
            // Always released -- success, a mapped failure, or the timeout
            // race itself all reach this `finally`. Never held past this
            // one call, so a failing call can never permanently strand a
            // permit for every call after it.
            release();
          }
        },
        requestTimeoutMs,
        target,
        () => {
          // Best-effort cleanup on timeout -- see `withRequestTimeout`'s doc
          // comment for the interleaving this cannot cover (a timeout that
          // fires before `connect()` has resolved at all). Aborting the
          // queue wait here matters specifically when the call is STILL
          // QUEUED (never reached `connect()` at all): without this, the
          // queued `acquire()` would eventually resolve once a permit frees
          // up, grab a permit for a call nobody is waiting on any more, and
          // never release it back (nothing downstream would ever call the
          // `release` this path returns).
          abortQueue.abort(new PeerRequestTimeoutError(target, requestTimeoutMs));
          void opened?.close();
        },
      );
    } catch (err) {
      throw mapPeerCallError(err, target);
    }
  };
}
