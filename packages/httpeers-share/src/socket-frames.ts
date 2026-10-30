/**
 * WebSocket messages inside one streaming HTTP request over the mesh (rung 15:
 * a mesh request is full-duplex). Each frame: 1 byte type, 4 bytes length
 * (big-endian), payload.
 *
 *   text   (1): UTF-8
 *   binary (2): bytes
 *   close  (3): 2 bytes code, then the reason in UTF-8
 *   open   (4): the subprotocol the app accepted, in UTF-8 (first frame back)
 */

export type SocketFrame =
  | { type: "text"; data: string }
  | { type: "binary"; data: Uint8Array }
  | { type: "close"; code: number; reason: string }
  | { type: "open"; protocol: string };

/** Asks a Service's upstream for a socket instead of a response: the header names the subprotocols. */
export const SOCKET_HEADER = "x-peershare-websocket";

const TEXT = 1;
const BINARY = 2;
const CLOSE = 3;
const OPEN = 4;
const HEAD = 5;

export function encodeFrame(frame: SocketFrame): Uint8Array {
  const enc = new TextEncoder();
  let type: number;
  let payload: Uint8Array;
  if (frame.type === "text") {
    type = TEXT;
    payload = enc.encode(frame.data);
  } else if (frame.type === "binary") {
    type = BINARY;
    payload = frame.data;
  } else if (frame.type === "open") {
    type = OPEN;
    payload = enc.encode(frame.protocol);
  } else {
    type = CLOSE;
    const reason = enc.encode(frame.reason);
    payload = new Uint8Array(2 + reason.length);
    new DataView(payload.buffer).setUint16(0, frame.code);
    payload.set(reason, 2);
  }
  const out = new Uint8Array(HEAD + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, payload.length);
  out.set(payload, HEAD);
  return out;
}

/** Bytes, chunked any way, to frames. */
export function decodeFrames(): TransformStream<Uint8Array, SocketFrame> {
  let buffer = new Uint8Array(0);
  const dec = new TextDecoder();
  return new TransformStream({
    transform(chunk, controller) {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      buffer = joined;
      while (buffer.length >= HEAD) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const length = view.getUint32(1);
        if (buffer.length < HEAD + length) break;
        const type = view.getUint8(0);
        const payload = buffer.slice(HEAD, HEAD + length);
        buffer = buffer.slice(HEAD + length);
        if (type === TEXT) controller.enqueue({ type: "text", data: dec.decode(payload) });
        else if (type === BINARY) controller.enqueue({ type: "binary", data: payload });
        else if (type === CLOSE) {
          const code = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
          controller.enqueue({ type: "close", code, reason: dec.decode(payload.slice(2)) });
        } else if (type === OPEN)
          controller.enqueue({ type: "open", protocol: dec.decode(payload) });
        else controller.error(new Error(`unknown socket frame type ${type}`));
      }
    },
  });
}
