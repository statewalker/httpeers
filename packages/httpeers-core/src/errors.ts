/**
 * T-2: the error taxonomy for a peer-to-peer *call* — the outcomes a caller
 * of `Peer.call()` / `Remote` can observe when the other side is anything
 * other than "answered normally".
 *
 * Before this file existed, peer offline, protocol unsupported, stream
 * reset, relay data-limit exceeded, and request timeout all surfaced as
 * whatever exception the transport happened to throw first — an
 * `AggregateError` from a failed dial, a bare `Error` named
 * `UnsupportedProtocolError` from `@libp2p/interface`, or a `StreamResetError`
 * from deep inside a yamux stream, depending on which layer gave up. A
 * caller had no way to tell "this peer is gone" from "this peer refused
 * you" from "we gave up waiting" without parsing a message string.
 *
 * THE DISCRIMINANT. This package already has a working answer, twice over,
 * and this file follows it rather than inventing a third: `TokenVerificationError`
 * (`tokens.ts`) carries a stable `reason` string, and `RevocationCache.check`
 * (`revocation.ts`) returns a reason string rather than a boolean. Every
 * class below carries both: a stable `readonly kind` string (so a caller can
 * `switch` on it, or forward it across a boundary that cannot carry a class
 * reference) AND its own class (so `instanceof` works, matching the existing
 * `PeerBindingLostError` precedent in `peer-handlers.ts`). Neither alone was
 * enough — a bare `kind` string loses the stack trace and the `cause` chain;
 * a class alone forces every caller to import every class it might want to
 * compare against.
 *
 * WHAT LIVES HERE, WHAT DOESN'T. Only the errors a *call* can raise —
 * `PeerCallError` and its subclasses. `TokenVerificationError` stays in
 * `tokens.ts` (it is about a token's own validity, not about reaching a
 * peer) and `PeerBindingLostError` stays in `peer-handlers.ts` (it is not a
 * network condition at all — see its own doc comment, and the note on
 * `PeerBindingLostError` below). Both are already exported from the package
 * root via `index.ts`'s `export *`; this file does not re-export them, to
 * avoid two star-exports colliding on the same name. Conceptually, though,
 * they belong to the same taxonomy this file documents, and a caller
 * building a full `switch` over "everything a call through this package can
 * throw" needs all three files' exports, not just this one's.
 *
 * NO LIBP2P IMPORT. This file is deliberately transport-agnostic — it knows
 * nothing about libp2p, yamux, or multistream-select. The mapping from a
 * concrete libp2p failure to one of these classes lives in
 * `transport-duplex.ts` (`mapPeerCallError`), the one file besides
 * `tokens.ts` this package's isolation grep allows to import libp2p. That
 * split is what keeps the taxonomy itself swappable along with the
 * transport: a future transport adapter maps its own failures onto the same
 * five classes, and nothing above `transport-duplex.ts` has to change.
 *
 * THE TIMEOUT POLICY. See `DEFAULT_REQUEST_TIMEOUT_MS` in
 * `transport-duplex.ts` for the default and its relationship to
 * `DEFAULT_DRAIN_TIMEOUT_MS`.
 *
 * THE RETRY POLICY. This package does not retry — see each class's doc
 * comment below for whether retrying *that* class is ever sound, and under
 * what condition (idempotency, backoff). Building a retry mechanism is
 * explicitly out of scope for T-2; stating which rows must never be retried
 * is not.
 */
import type { PeerIdStr } from "./types.js";

/**
 * The stable, matchable discriminant every `PeerCallError` carries. Kept as
 * a plain string union (not an enum) so it survives `JSON.stringify` and a
 * `switch` without importing this module — the same reasoning that made
 * `RevocationCache.check` return a string rather than a boolean.
 */
export type PeerErrorKind =
  | "peer-unreachable"
  | "protocol-unsupported"
  | "stream-reset"
  | "relay-limit-exceeded"
  | "request-timeout"
  | "unknown";

/**
 * Base class for everything `Peer.call()` / `Remote` can reject with. Never
 * thrown directly — always one of the concrete subclasses below, or
 * `UnknownPeerCallError` as the last resort. `peerId` is always the target
 * that was being called, even when the underlying failure (e.g. an
 * `AggregateError` from a failed dial) does not itself carry one.
 *
 * `cause` uses the ES2022 `Error.cause` chain rather than a bespoke field —
 * the original libp2p error is never discarded, only wrapped, so a caller
 * that needs the raw detail (a log line, a bug report) can still reach it
 * via `error.cause`.
 */
export abstract class PeerCallError extends Error {
  abstract readonly kind: PeerErrorKind;
  readonly peerId: PeerIdStr;

  constructor(message: string, peerId: PeerIdStr, options?: { cause?: unknown }) {
    super(message, options);
    this.peerId = peerId;
  }
}

/**
 * The peer could not be reached at all: no address is known for it, every
 * known address refused or failed to connect, or our own dial queue/gater
 * refused to try. Grounded in `libp2p`'s dial path (`dial-queue.js`'s
 * `dialPeer`), and refined by actually running it rather than reading it
 * alone (see the Task 17 report): `NoValidAddressesError` when the peerId
 * has no address this node can dial; a bare
 * `AggregateError('All multiaddr dials failed')` — NOT a named libp2p error
 * class — when 2+ addresses were tried and every one failed; and, when
 * exactly ONE address was tried (the common case for an httpeers peer,
 * which usually has one listen address), `dialPeer` unwraps and rethrows
 * that single address's raw error DIRECTLY (`if (errors.length === 1) throw
 * errors[0]`) — a plain `Error` from `@libp2p/tcp`'s `net.connect`, with
 * `.name === "Error"` and no libp2p identity at all, distinguishable only
 * by Node's own `.code` (`ECONNREFUSED` and neighbours — see
 * `CONNECTION_ESTABLISHMENT_ERRNO` in `transport-duplex.ts`). All three
 * collapse into this one class: from the caller's perspective "no address
 * is known" and "every address refused" are the same actionable outcome —
 * the peer is not reachable right now.
 *
 * RETRY: potentially sound, with backoff, since the cause may be transient
 * (the peer is mid-restart, a NAT mapping expired, a transient network
 * partition). This package takes no position on how long to back off; a
 * caller retrying immediately in a loop is indistinguishable from a caller
 * that never checked why the first attempt failed.
 */
export class PeerUnreachableError extends PeerCallError {
  readonly kind = "peer-unreachable" as const;
  constructor(peerId: PeerIdStr, options?: { cause?: unknown }) {
    super(`peer ${peerId} is unreachable`, peerId, options);
    this.name = "PeerUnreachableError";
  }
}

/**
 * The peer was reached, but does not speak this protocol id — grounded in
 * `@libp2p/multistream-select`'s `select()`, which throws
 * `UnsupportedProtocolError` (`@libp2p/interface`) when none of the offered
 * protocol ids come back acknowledged. In this stack that means the far
 * side is a libp2p node that never called `serveTransport` (or was built
 * with a different `PROTOCOL` string) — a real peer, just not an httpeers
 * one, or one running an incompatible version.
 *
 * RETRY: never sound against the same peer with the same protocol id — the
 * remote's protocol table does not change between one call and the next
 * within the timeframe any retry policy would operate on. Retrying only
 * repeats the negotiation failure. The only real fix is a different
 * protocol id (a version negotiation this package does not have) or a
 * different peer.
 */
export class PeerProtocolUnsupportedError extends PeerCallError {
  readonly kind = "protocol-unsupported" as const;
  constructor(peerId: PeerIdStr, protocol: string, options?: { cause?: unknown }) {
    super(`peer ${peerId} does not support protocol ${protocol}`, peerId, options);
    this.name = "PeerProtocolUnsupportedError";
  }
}

/**
 * The stream was reset — by the remote muxer, or by our own side hitting a
 * concurrency limit. Grounded in two distinct, both-real code paths in
 * `libp2p`'s `Connection` (`connection.js`):
 *
 *  - our own OUTBOUND cap (`TooManyOutboundProtocolStreamsError`): thrown
 *    inside `newStream`'s own async body, AFTER `await mss.select(...)` has
 *    resolved (`connection.js:118` in `libp2p@3.3.8`) — rejects the call
 *    before the stream is ever handed back, and does not queue it. CORRECTED
 *    ON REVIEW (Task 18): earlier drafts of this comment (and of
 *    `PROVENANCE.md`'s row 3a) called this throw "SYNCHRONOUS". It is not,
 *    in the sense that matters here — it is an ordinary async rejection
 *    from inside a promise chain, not a throw that escapes synchronously
 *    to an unrelated caller with nothing able to catch it. That distinction
 *    is exactly what separates this row from the genuinely synchronous,
 *    UNCATCHABLE throw Task 18 also investigated (`YamuxStream.onRemoteReset`
 *    dispatching a `StreamResetEvent` synchronously out of a dial burst,
 *    outside any promise this package's own `try`/`catch` can reach) — see
 *    the Task 18 report for that investigation's result. The two must not be
 *    conflated: this row rejects a promise `mapPeerCallError` can map, same
 *    as every other row in this file; the other is a process-killing defect
 *    in a dependency, unrelated to this taxonomy;
 *  - the remote's INBOUND cap (`TooManyInboundProtocolStreamsError`):
 *    thrown on the SERVING side inside `onIncomingStream`, which the server
 *    turns into `muxedStream.abort(err)` — the caller never sees that
 *    class or message, only the RESET it produces (a
 *    `StreamResetError`/close event on its own end of the stream).
 *
 * This is the mechanism behind ledger note 18's "concurrency cliff": one
 * libp2p stream per in-flight request, `maxInboundStreams`/`maxOutboundStreams`
 * reset rather than queued past the cap. `DEFAULT_MAX_STREAMS` (512, see
 * `transport-duplex.ts`) raises the ceiling; it does not remove this failure
 * mode by itself. Task 18 (T-3) closes the outbound half: `createRemote`
 * now queues excess outbound calls behind an in-process semaphore
 * (`DEFAULT_MAX_CONCURRENT_OUTBOUND`, `transport-duplex.ts`) so a
 * well-behaved `Remote` reaches this OUTBOUND branch only if
 * `maxConcurrentOutbound` is configured wider than `maxOutboundStreams` —
 * `tests/concurrency.test.ts` proves the branch still maps correctly when
 * that happens, closing what had been row 3a's inspection-backed-only
 * status. The INBOUND branch (row 3b below) has no client-side mitigation
 * by design — a server cannot bound how many DIFFERENT peers dial it at
 * once, only how long each one may hold a stream open
 * (`DEFAULT_DRAIN_TIMEOUT_MS`) and how many it may hold at all
 * (`DEFAULT_MAX_STREAMS`). This class and its tests
 * (`tests/errors.test.ts`, `tests/concurrency.test.ts`) prove that whenever
 * a reset happens — inbound or outbound, at N=1 or at N=512, same code
 * family — the caller observes this typed error, not a raw
 * `StreamResetError`.
 *
 * A THIRD, non-obvious source, found only by running the reset test rather
 * than by reading source (see the Task 17 report): a reset that lands
 * before the peer's own handler ever wrote a response byte does not surface
 * as any libp2p stream-error class at all by the time it reaches this
 * package's HTTP codec layer. `duplexOverStream` (`webrun-streams-libp2p`)
 * does not distinguish "reset" from "closed with nothing written" — both
 * end the client's read loop with zero frames — so the codec's format
 * sniffer (`sniff.ts` in `@statewalker/webrun-http-streams`) sees
 * end-of-stream on its very first read and throws `HttpParseError("sniff:
 * stream ended before any bytes arrived")`. `mapPeerCallError` matches that
 * exact message (not every `HttpParseError` — a genuinely malformed
 * response from a foreign codec is a different, real condition) into this
 * class.
 *
 * RETRY: conditionally sound, and only for a request the caller knows is
 * idempotent (this package carries no idempotency-key layer to make a
 * non-idempotent retry safe). A cap-driven reset is usually transient
 * congestion; a reset triggered by the remote peer's own logic
 * (application-level abort) may not be.
 */
export class PeerStreamResetError extends PeerCallError {
  readonly kind = "stream-reset" as const;
  constructor(peerId: PeerIdStr, options?: { cause?: unknown }) {
    super(`stream to peer ${peerId} was reset`, peerId, options);
    this.name = "PeerStreamResetError";
  }
}

/**
 * The call was running over a relayed (circuit) connection and the relay's
 * own data limit for that reservation was exceeded. Grounded in
 * `@libp2p/circuit-relay-v2`'s `utils.js` (`countStreamBytes`, `LimitTracker`),
 * which throws `TransferLimitError('data limit of <n> bytes exceeded')` on
 * the relay itself once a relayed stream's byte count passes the
 * reservation's `dataLimit` (128 KiB by default, `DEFAULT_DATA_LIMIT`).
 *
 * NOT WIRED, NOT TESTED — see the Task 17 report. `createNode`
 * (`transport-duplex.ts`) configures TCP direct dialing only; this package
 * does not depend on `@libp2p/circuit-relay-v2` and has no relay transport
 * in its stack, so this condition cannot be provoked in-process today. The
 * class exists because the brief names it as a minimum row and because
 * `TransferLimitError` is real, grounded, load-bearing library behaviour —
 * not because there is a wired path that produces it. `mapPeerCallError`
 * matches it by `err.name === "TransferLimitError"` (a string check, since
 * this package cannot import a class from a dependency it does not have)
 * so the mapping activates for free the day a relay transport is added,
 * but that string match itself is therefore also untested.
 *
 * RETRY: never sound against the same relay reservation — the limit is
 * fixed for that reservation's lifetime. A fresh reservation (a different
 * relay, or a renewed one) is a new call, not a retry of this one.
 */
export class PeerRelayLimitExceededError extends PeerCallError {
  readonly kind = "relay-limit-exceeded" as const;
  constructor(peerId: PeerIdStr, options?: { cause?: unknown }) {
    super(`relay data limit exceeded while calling peer ${peerId}`, peerId, options);
    this.name = "PeerRelayLimitExceededError";
  }
}

/**
 * This package gave up waiting for a response before the peer produced
 * one. See `DEFAULT_REQUEST_TIMEOUT_MS` (`transport-duplex.ts`) for the
 * default and how it relates to `DEFAULT_DRAIN_TIMEOUT_MS`. Unlike the
 * other rows, this is not a libp2p failure being mapped — it is this
 * package's own policy firing, wrapping whatever the in-flight call was
 * still doing (dialing, negotiating, or waiting on a response) when the
 * clock ran out.
 *
 * RETRY: conditionally sound, and only for a request the caller knows is
 * idempotent, same caveat as `PeerStreamResetError` — a timeout gives no
 * information about whether the peer had already started (or finished)
 * acting on a non-idempotent request before the timer fired.
 */
export class PeerRequestTimeoutError extends PeerCallError {
  readonly kind = "request-timeout" as const;
  constructor(peerId: PeerIdStr, timeoutMs: number, options?: { cause?: unknown }) {
    super(`request to peer ${peerId} timed out after ${timeoutMs}ms`, peerId, options);
    this.name = "PeerRequestTimeoutError";
  }
}

/**
 * The call failed for a reason `mapPeerCallError` does not recognise. This
 * exists so `Peer.call()` / `Remote` keep the contract "you always get a
 * `PeerCallError`, never a raw transport exception" even for a failure mode
 * nobody has enumerated yet — the alternative (letting an unrecognised
 * error escape unwrapped) silently breaks that contract exactly when a
 * caller's `instanceof PeerCallError` guard would otherwise have caught it.
 * The original error is always preserved as `cause`. A test hitting this
 * class is a prompt to give the underlying condition its own row, not a
 * passing test to leave alone.
 */
export class UnknownPeerCallError extends PeerCallError {
  readonly kind = "unknown" as const;
  constructor(peerId: PeerIdStr, options?: { cause?: unknown }) {
    const detail = options?.cause instanceof Error ? options.cause.message : String(options?.cause);
    super(`call to peer ${peerId} failed: ${detail}`, peerId, options);
    this.name = "UnknownPeerCallError";
  }
}
