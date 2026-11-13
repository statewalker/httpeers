/**
 * How a caller built on webrun-rpc 0.10 saved the window handshake's round
 * trip, for interop tests: the wrapper `src/mux-presumed-ack.ts` that
 * httpeers-libp2p ran on the caller side before webrun-rpc 0.11 added
 * `presumeAck`. Every caller of `/httpeers/1.0.0/mux` built from then on runs
 * it, so a serving side of this version must keep answering it in one round
 * trip.
 *
 * When the mux posts a windowed `open`, it is handed, in the same turn, the
 * ack the responder will send (`exact`, the same capabilities), so it posts
 * its answer right behind the `open` and pipelines from the start. The real
 * ack is checked against that, as the deployed callers check it: on a
 * mismatch, or anything but a `close` before the ack, they close the mux, so
 * `onBroken` runs here (a test makes it fail). The silence watchdog is left
 * out: it never fires against a peer that answers.
 */

import type { MessageTarget, PortCodec, PortEnvelope } from "webrun-rpc-0-10";

type Listener = (event: MessageEvent) => void | Promise<void>;

/** The codec and target to give a 0.10 caller's `multiplexPort`. */
export function oldPresumingAcks(
  inner: PortCodec,
  pipe: MessageTarget,
  onBroken: (error: Error) => void,
): { codec: PortCodec; target: MessageTarget } {
  let muxListener: Listener | undefined;
  const presumedOf = new WeakMap<MessageEvent, PortEnvelope>();
  /** Ports whose ack was presumed and has not arrived yet: the capabilities presumed. */
  const awaitingAck = new Map<number, readonly string[]>();
  const check = (envelope: PortEnvelope): void => {
    const id = (envelope as { id?: unknown }).id;
    if (typeof id !== "number") return;
    const presumed = awaitingAck.get(id);
    if (presumed == null) return;
    awaitingAck.delete(id);
    if (envelope.type !== "credit") {
      if (envelope.type !== "close") {
        onBroken(new Error(`the peer sent ${envelope.type} on port ${id} before its ack`));
      }
      return;
    }
    const ack = envelope as { bytes?: unknown; exact?: unknown; caps?: unknown };
    const caps = Array.isArray(ack.caps) ? ack.caps : [];
    if (
      ack.bytes !== 0 ||
      ack.exact !== true ||
      caps.length !== presumed.length ||
      !presumed.every((cap) => caps.includes(cap))
    ) {
      onBroken(
        new Error(
          `the peer acknowledged port ${id} with ${JSON.stringify({ bytes: ack.bytes, exact: ack.exact, caps: ack.caps })}, not ${presumed.join(", ")}`,
        ),
      );
    }
  };
  const codec: PortCodec = {
    ...inner,
    post(port, envelope, transfer) {
      inner.post(port, envelope, transfer);
      if (envelope.type !== "open") return;
      const open = envelope as { window?: unknown; exact?: unknown; caps?: unknown };
      if (typeof open.window !== "number" || open.exact !== true || !Array.isArray(open.caps)) {
        return;
      }
      const caps = open.caps.filter((cap): cap is string => typeof cap === "string");
      const ack = { type: "credit", id: envelope.id, bytes: 0, exact: true, caps } as PortEnvelope;
      awaitingAck.set(envelope.id, caps);
      const event = new MessageEvent("message", { data: null });
      presumedOf.set(event, ack);
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
  return { codec, target };
}
