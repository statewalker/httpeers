/**
 * The bridge: HTTP over a duplex, both directions, with no transport in it.
 *
 * A peer call is a `Request` in and a `Response` out, carried over one duplex
 * stream. `@statewalker/webrun-http-streams` does that carrying
 * (`fetchOverDuplex` / `serveFetchOverDuplex`); what this package adds is the
 * two things a MESH needs on top and neither of those functions knows about:
 *
 *   1. **Identity on arrival.** The peer the transport proved is bound to the
 *      inbound request before dispatch, replacing anything the caller sent.
 *   2. **One stream per call, bounded.** A concurrency permit, a per-call
 *      timeout, and cleanup that survives the timeout firing mid-dial.
 *
 * WHY IT IS ITS OWN PACKAGE. All of that used to live inside
 * `httpeers-libp2p`'s transport module, welded to `connect`/`serveConnections`
 * from `webrun-streams-libp2p`. Only two questions in it were ever
 * libp2p-specific — "how do I get a duplex to that peer" and "how do I accept
 * one" — so those two become `PeerLink` and everything else runs over
 * anything. The immediate payoff is that a mesh can be exercised over
 * `MessageChannel` in one process, with no relay and no WebRTC; the durable
 * one is that a WebSocket or a worker transport is now a ~40-line adapter
 * rather than a fork of this logic.
 */

import {
  PeerRequestTimeoutError,
  registerPeer,
  type FetchHandler,
  type PeerIdStr,
  type ProvenPeer,
  type Remote,
} from "@statewalker/httpeers-core";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import type { Duplex } from "@statewalker/webrun-streams";

/** An open duplex to one peer, and the way to let it go. */
export interface PeerConnection {
  /** The duplex itself, in `webrun-streams` shape. */
  call: Duplex;
  close(): Promise<void>;
}

/**
 * Everything a transport must answer, and nothing else.
 *
 * `serve`'s callback receives what the transport PROVED about the far side.
 * For libp2p that is the Noise handshake's `remotePeer`; for a point-to-point
 * MessagePort it is asserted at construction, because a raw port proves
 * nothing. A link that cannot establish identity should pass `ANONYMOUS`
 * rather than a guess — the whole authorization layer reads this value.
 */
export interface PeerLink {
  /** Open a duplex to `peerId`. One per call: the bridge never reuses one. */
  open(peerId: PeerIdStr): Promise<PeerConnection>;
  /** Accept inbound duplexes. The factory is called once per connection. */
  serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<() => Promise<void>>;
}

/** Concurrent outbound calls in flight, across all targets. */
export const DEFAULT_MAX_CONCURRENT_OUTBOUND = 64;
/** How long one call may take, dial included. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ServeFetchOverLinkInit {
  link: PeerLink;
  /** This peer's router. Receives every inbound request with its identity already bound. */
  dispatch: FetchHandler;
}

/**
 * Serve this peer's `dispatch` to everyone who connects.
 *
 * The identity binding is the load-bearing line. `registerPeer` STRIPS any
 * value the caller sent before writing what the link proved, so a request
 * arriving with a hand-set `x-httpeers-peer` is corrected here rather than
 * believed downstream. Every ingress in this system owes that guarantee; this
 * is the one for peer-to-peer traffic.
 */
export async function serveFetchOverLink(
  init: ServeFetchOverLinkInit,
): Promise<() => Promise<void>> {
  return init.link.serve((peer: ProvenPeer) =>
    serveFetchOverDuplex(async (req: Request) => {
      registerPeer(req, peer as PeerIdStr);
      return init.dispatch(req);
    }),
  );
}

export interface CreateRemoteOverLinkInit {
  link: PeerLink;
  /** Defaults to {@link DEFAULT_MAX_CONCURRENT_OUTBOUND}. */
  maxConcurrentOutbound?: number;
  /** Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /**
   * Turn a transport's own failure into a `PeerCallError`.
   *
   * Left to the caller because the strings are transport-specific — libp2p
   * says "All multiaddr dials failed", a WebSocket says something else — and a
   * bridge that pattern-matched one transport's wording would quietly
   * mis-classify every other one. Return `undefined` to let the original
   * throw through unchanged.
   */
  mapError?: (error: unknown, target: PeerIdStr) => Error | undefined;
}

/** Call another peer: one duplex per call, bounded and cleaned up. */
export function createRemoteOverLink(init: CreateRemoteOverLinkInit): Remote {
  const {
    link,
    maxConcurrentOutbound = DEFAULT_MAX_CONCURRENT_OUTBOUND,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    mapError,
  } = init;
  const permits = new Semaphore(maxConcurrentOutbound);

  return async (target: PeerIdStr, req: Request): Promise<Response> => {
    let opened: PeerConnection | undefined;
    // The queue wait rides the SAME timeout that bounds the call, so a request
    // that never got a permit fails on time instead of waiting forever behind
    // one that is itself stuck.
    const abortQueue = new AbortController();
    const timer = new Timeout(requestTimeoutMs, () => {
      abortQueue.abort(new PeerRequestTimeoutError(target, requestTimeoutMs));
      // Best effort: a timeout that fires before `open()` resolves cannot
      // close a connection that does not exist yet. The permit is still
      // released by the `finally` below, which is what actually matters.
      void opened?.close();
    });

    try {
      const release = await permits.acquire(abortQueue.signal);
      try {
        opened = await link.open(target);
        return await Promise.race([timer.rejection(), fetchOverDuplex(opened.call, req)]);
      } finally {
        release();
      }
    } catch (error) {
      // The connection is closed HERE and only here. On the success path it
      // must stay open: `fetchOverDuplex` resolves as soon as the response
      // HEAD is parsed, and the BODY is still streaming over this very duplex
      // -- closing it in a `finally` produced a `Response` whose `.text()`
      // never resolved. (It did, on the first attempt: every test in this
      // package timed out rather than failed, which is what that looks like.)
      // The stream ends itself when the body does.
      void opened?.close().catch(() => {});
      const mapped = mapError?.(error, target);
      throw mapped ?? error;
    } finally {
      timer.cancel();
    }
  };
}

/**
 * A fixed number of permits, handed out in arrival order.
 *
 * Bounds how many duplexes this peer holds open at once. Without it, a page
 * that fires a hundred calls opens a hundred streams and the far side's
 * inbound limit starts refusing them — which surfaces as unrelated calls
 * failing, not as "too many in flight".
 */
class Semaphore {
  #free: number;
  readonly #waiting: Array<{ resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(size: number) {
    this.#free = size;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw signal.reason;
    if (this.#free > 0) {
      this.#free -= 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
      entry.onAbort = () => {
        const at = this.#waiting.indexOf(entry);
        if (at >= 0) this.#waiting.splice(at, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.#waiting.push(entry);
    });
    return () => this.#release();
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#free += 1;
      return;
    }
    if (next.onAbort !== undefined) next.signal?.removeEventListener("abort", next.onAbort);
    next.resolve();
  }
}

/** A rejection that fires once, and can be cancelled without leaving a timer behind. */
class Timeout {
  readonly #handle: ReturnType<typeof setTimeout>;
  readonly #promise: Promise<never>;

  constructor(ms: number, onFire: () => void) {
    let reject!: (e: unknown) => void;
    this.#promise = new Promise<never>((_, r) => {
      reject = r;
    });
    // Never keep a process alive for a call nobody is waiting on.
    this.#handle = setTimeout(() => {
      onFire();
      reject(new Error(`peer call timed out after ${ms}ms`));
    }, ms);
    this.#handle.unref?.();
    // Nothing may observe this rejection if the call wins the race, and an
    // unobserved rejection is a process-level warning in Node.
    this.#promise.catch(() => {});
  }

  rejection(): Promise<never> {
    return this.#promise;
  }

  cancel(): void {
    clearTimeout(this.#handle);
  }
}
