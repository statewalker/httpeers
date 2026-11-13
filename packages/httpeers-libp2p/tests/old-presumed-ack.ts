/**
 * How a caller built on webrun-rpc 0.10 saved the window handshake's round
 * trip, for interop tests: the wrapper `src/mux-presumed-ack.ts` that
 * httpeers-libp2p ran on the caller side before webrun-rpc 0.11 added
 * `presumeAck`. Every caller of `/httpeers/1.0.0/mux` built from then on runs
 * it, so a serving side of this version must keep answering it in one round
 * trip.
 *
 * Only what reaches the wire is kept: when the mux posts a windowed `open`, it
 * is handed, in the same turn, the ack the responder will send (`exact`, the
 * same capabilities), so it posts its answer right behind the `open` and
 * pipelines from the start. The check of the real ack and the silence watchdog
 * are left out: they never send anything.
 */

import type { MessageTarget, PortCodec, PortEnvelope } from "webrun-rpc-0-10";

type Listener = (event: MessageEvent) => void | Promise<void>;

/** The codec and target to give a 0.10 caller's `multiplexPort`. */
export function oldPresumingAcks(
  inner: PortCodec,
  pipe: MessageTarget,
): { codec: PortCodec; target: MessageTarget } {
  let muxListener: Listener | undefined;
  const presumedOf = new WeakMap<MessageEvent, PortEnvelope>();
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
      const event = new MessageEvent("message", { data: null });
      presumedOf.set(event, ack);
      void muxListener?.(event);
    },
    read(event) {
      return presumedOf.get(event) ?? inner.read(event);
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
