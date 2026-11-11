/**
 * The caller's half of the mux (`mux-link.ts`) without the window handshake's
 * round trip (#56): every port's window agreement taken as given when the port
 * opens, instead of one round trip later.
 *
 * WHAT THE HANDSHAKE COSTS. webrun-rpc's `multiplexPort` (0.10) agrees each
 * port's window in three steps: the opener's `open` (window, `exact`, caps),
 * the responder's zero-byte `credit` ack (its `exact` and caps), and the
 * opener's zero-byte `credit` answer to the ack. Until an end has seen the
 * other's step it sends each chunk of a stream as a call the peer confirms
 * once its consumer has read past it (`duplexOverPort`), and only afterwards
 * as plain messages held back by the window ("pipelined"). So:
 *
 *   - the responder pipelines only once the answer arrives, 1.5 round trips
 *     after the port opened: a response written before then goes as a call,
 *     and the body behind the head waits for the head's confirmation. A GET
 *     got its head after one round trip and its body after two;
 *   - the opener pipelines only once the ack arrives, one round trip in: a
 *     request whose end (`done`) follows its first chunk waits for that chunk's
 *     confirmation, so a POST whose handler reads the body to its end got its
 *     response after two round trips.
 *
 * WHAT THIS DOES. When the caller posts an `open` with a window, exact sizing
 * and capabilities, it hands its own mux, in the same turn, the ack the
 * responder will send: `exact` and the same capabilities. The mux then does
 * what it does on the real ack: it posts its answer at once (right behind the
 * `open`, so the responder pipelines from the start) and pipelines this
 * side's chunks from the start. Both directions of an exchange take one
 * round trip.
 *
 * WHY IT IS SAFE, AND WIRE-COMPATIBLE. Nothing new goes on the wire: the
 * answer is the same envelope, only sent earlier, and a responder handles it
 * exactly as before (a credit for a port it has, read after the `open` it
 * follows on the same stream). What the caller presumes is what every
 * responder on this protocol answers: every build that has served
 * `/httpeers/1.0.0/mux` runs `multiplexPort` from webrun-rpc 0.10 with the
 * msgpack codec, which acks every windowed `open` with `exact` and with the
 * opener's capabilities (`pipeline`, `end`), and returns credit for what its
 * consumers read. The presumption is checked: when the real ack arrives and
 * says anything else, `onBroken` runs and the caller closes the mux (every
 * exchange on it fails, and the next call dials a new one, which presumes
 * nothing on that connection: the full handshake, two round trips).
 *
 * WHAT A REFUSED PORT COSTS. A responder that refuses the port (`maxPorts`,
 * `onPort`) closes it as before and drops what arrives for it without
 * buffering it. But the caller no longer waits for its first chunk to be
 * confirmed before sending the next: until the refusal reaches it, it may
 * send up to one window of request body (256 KiB by default, the `window`
 * option or the hub's `HUB_MUX_WINDOW` otherwise; about 246 KB measured) that the
 * responder throws away, where before it sent one chunk.
 *
 * THE KEEPALIVE. The mux counts anything it reads as a sign of life, the
 * presumed ack included, so a caller that kept opening ports would keep its
 * keepalive content with a peer that froze. This module therefore runs the
 * same check on what really arrives: after `misses` intervals in a row with
 * nothing from a peer that has answered a keepalive before, and no backlog of
 * this side's own, `onBroken` runs.
 *
 * UPSTREAM, the same saving needs no presumption: a responder may enforce the
 * window as soon as an `open` lists `caps` (only a version that reads credit
 * lists them), and an opener may pipeline before the ack where the protocol
 * is known to be windowed (an option). Until webrun-rpc does that, this
 * module does it from outside, for the caller.
 */

import type { MessageTarget, PortCodec, PortEnvelope } from "@statewalker/webrun-rpc";

type Listener = (event: MessageEvent) => void | Promise<void>;

/** What {@link presumingAcks} needs. */
export interface PresumingAcksInit {
  codec: PortCodec;
  target: MessageTarget;
  /** The mux's keepalive interval, in ms; `0` runs no check of its own. */
  keepaliveMs: number;
  /** Intervals in a row with nothing from the peer before `onBroken` (the mux's `misses`). */
  misses: number;
  /**
   * Close the mux: the real ack contradicted the presumption (`contradicted`:
   * then presume nothing on this connection again), or the peer went silent.
   */
  onBroken: (error: Error, contradicted: boolean) => void;
}

/** The codec and target to give the caller's `multiplexPort`, and `stop`, for when the mux is over. */
export interface PresumingAcks {
  codec: PortCodec;
  target: MessageTarget;
  stop(): void;
}

/** Wrap the caller's codec and target so that each port's window is agreed when it opens; see the module comment. */
export function presumingAcks(init: PresumingAcksInit): PresumingAcks {
  const { codec: inner, target: pipe, onBroken } = init;
  /** The mux's own listener on the pipe, where the presumed ack is delivered. */
  let muxListener: Listener | undefined;
  /** Synthetic events, and the ack each carries. */
  const presumedOf = new WeakMap<MessageEvent, PortEnvelope>();
  /** Ports whose ack was presumed and has not arrived yet: the capabilities presumed. */
  const awaitingAck = new Map<number, readonly string[]>();
  let heard = true;
  let peerKeepsAlive = false;
  let silent = 0;
  let broken = false;

  const fail = (error: Error, contradicted = true): void => {
    if (broken) return;
    broken = true;
    onBroken(error, contradicted);
  };

  /** A real envelope from the peer: alive, and an ack checked against what was presumed. */
  const check = (envelope: PortEnvelope): void => {
    heard = true;
    if (envelope.type === "ping" || envelope.type === "pong") peerKeepsAlive = true;
    if (awaitingAck.size === 0) return;
    const id = (envelope as { id?: unknown }).id;
    if (typeof id !== "number") return;
    const presumed = awaitingAck.get(id);
    if (presumed == null) return;
    if (envelope.type !== "credit") {
      // A refusal closes the port without an ack (`maxPorts`); nothing else
      // can come before it.
      awaitingAck.delete(id);
      if (envelope.type !== "close") {
        fail(
          new Error(`httpeers-libp2p: the peer sent ${envelope.type} on port ${id} before its ack`),
        );
      }
      return;
    }
    awaitingAck.delete(id);
    const ack = envelope as { bytes?: unknown; exact?: unknown; caps?: unknown };
    const caps = Array.isArray(ack.caps) ? ack.caps : [];
    if (
      ack.bytes !== 0 ||
      ack.exact !== true ||
      caps.length !== presumed.length ||
      !presumed.every((cap) => caps.includes(cap))
    ) {
      fail(
        new Error(
          `httpeers-libp2p: the peer acknowledged port ${id} with ${JSON.stringify({ bytes: ack.bytes, exact: ack.exact, caps: ack.caps })}, not the exact sizing and capabilities (${presumed.join(", ")}) this side presumed`,
        ),
      );
    }
  };

  const codec: PortCodec = {
    ...inner,
    post(port, envelope, transfer) {
      inner.post(port, envelope, transfer);
      if (envelope.type !== "open" || broken) return;
      const open = envelope as { window?: unknown; exact?: unknown; caps?: unknown };
      if (typeof open.window !== "number" || open.exact !== true || !Array.isArray(open.caps)) {
        return;
      }
      const caps = open.caps.filter((cap): cap is string => typeof cap === "string");
      const ack = { type: "credit", id: envelope.id, bytes: 0, exact: true, caps } as PortEnvelope;
      awaitingAck.set(envelope.id, caps);
      const event = new MessageEvent("message", { data: null });
      presumedOf.set(event, ack);
      // The mux attached the port before posting its `open`: it takes the ack
      // now, posts its answer behind the `open`, and pipelines from here.
      void muxListener?.(event);
    },
    read(event) {
      const presumed = presumedOf.get(event);
      if (presumed != null) return presumed;
      const envelope = inner.read(event);
      if (envelope != null) check(envelope);
      return envelope;
    },
  };

  const target: MessageTarget = {
    addEventListener(type, listener) {
      muxListener = listener;
      pipe.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      if (muxListener === listener) muxListener = undefined;
      pipe.removeEventListener(type, listener);
    },
    postMessage: (message, transfer) => pipe.postMessage(message, transfer),
    get bufferedAmount() {
      return pipe.bufferedAmount;
    },
    ...(pipe.whenDrained == null
      ? {}
      : { whenDrained: () => pipe.whenDrained?.() as Promise<void> }),
    ...(pipe.start == null ? {} : { start: () => pipe.start?.() }),
    ...(pipe.close == null ? {} : { close: (reason?: unknown) => pipe.close?.(reason) }),
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (init.keepaliveMs > 0) {
    timer = setInterval(() => {
      // As the mux's own keepalive, on what really arrived: a backlog of this
      // side's is not the peer's silence, and a peer that never answered a
      // keepalive is never held to it.
      const backlogged = (pipe.bufferedAmount ?? 0) > 0;
      if (heard) silent = 0;
      else if (peerKeepsAlive && !backlogged) silent++;
      heard = false;
      if (silent >= init.misses) {
        fail(
          new Error(
            `httpeers-libp2p: nothing from the peer for ${init.misses} keepalive intervals of ${init.keepaliveMs} ms`,
          ),
          false,
        );
      }
    }, init.keepaliveMs);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    codec,
    target,
    stop() {
      clearInterval(timer);
      awaitingAck.clear();
    },
  };
}
