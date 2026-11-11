/**
 * One libp2p stream as a pipe of length-prefixed messages, for the mux path
 * (`mux-link.ts`) to run `multiplexPort` over.
 *
 * The wire format and the contract are exactly those of
 * `messageTargetOverStream` from `@statewalker/webrun-streams-libp2p` 0.2.0:
 * frames are `[varint length][bytes]`, reading starts at once, every message
 * the peer sent before closing is delivered before `signal` aborts, a length
 * past `maxMessageBytes` (or not a varint) aborts the stream, and
 * `postMessage` hands the frame to `stream.send()` without waiting for room.
 * The two interoperate byte for byte.
 *
 * WHY A COPY HERE. That function's read buffer never shrinks and doubles on
 * every refill (it compacts only by reallocating at twice the size), so on a
 * long-lived stream it grows with the TOTAL bytes ever received: about 450 MB
 * of `ArrayBuffer`s after 400 MB of bulk on one mux (measured with
 * `scripts/bench-mux.mjs`), all zero-filled as it grows. It also builds and
 * throws an `Error` to say "no length yet" each time a chunk ends on a frame
 * boundary, which is most chunks. Both cost the receiver of a mux CPU and
 * memory per byte. Here the buffer is compacted in place and stays within a
 * small multiple of one frame plus one incoming chunk, and an empty tail is
 * not parsed. Drop this
 * file for the library's function once it does the same.
 */

import type { Stream, StreamCloseEvent } from "@libp2p/interface";
import { PeerGoneError } from "@statewalker/webrun-streams-libp2p";

type Listener = (event: MessageEvent) => void | Promise<void>;

/** What {@link muxTargetOverStream} gives: a byte pipe, and its life. */
export interface MuxStreamTarget {
  target: {
    addEventListener(type: "message", listener: Listener): void;
    removeEventListener(type: "message", listener: Listener): void;
    postMessage(message: unknown): void;
    close(): Promise<void>;
    readonly bufferedAmount: number;
    whenDrained(): Promise<void>;
  };
  /** Aborts when the stream is over, after every message the peer sent has been delivered. */
  signal: AbortSignal;
}

/** A graceful close's bound before falling back to a reset, as the library's (5 min). */
const CLOSE_TIMEOUT_MS = 5 * 60_000;

/** The stream as a message pipe; see the module comment. */
export function muxTargetOverStream(
  stream: Stream,
  { maxMessageBytes }: { maxMessageBytes: number },
): MuxStreamTarget {
  const listeners = new Set<Listener>();
  const life = new AbortController();
  let peerClosedWrite = false;

  const onRemoteCloseWrite = (): void => {
    // The read loop may still hold the peer's last messages; it aborts
    // `signal` once it has delivered them.
    peerClosedWrite = true;
  };
  const onClose = (evt: StreamCloseEvent): void => {
    stream.removeEventListener("remoteCloseWrite", onRemoteCloseWrite);
    if (peerClosedWrite && evt.error == null) return; // the read loop ends it
    life.abort(new PeerGoneError(evt.error));
  };
  stream.addEventListener("remoteCloseWrite", onRemoteCloseWrite);
  stream.addEventListener("close", onClose, { once: true });

  const deliver = (data: Uint8Array): void => {
    const event = new MessageEvent("message", { data });
    for (const listener of [...listeners]) {
      try {
        // One listener's fault must not stop the read loop.
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {}
    }
  };

  void (async () => {
    // Unread bytes are `buf[start, end)`.
    let buf = new Uint8Array(0);
    let start = 0;
    let end = 0;
    for await (const item of stream) {
      const incoming = toBytes(item);
      if (incoming.byteLength === 0) continue;
      if (start === end) {
        // Nothing held: parse the chunk where it lies, and keep only its tail.
        start = 0;
        end = 0;
        const used = deliverFrames(incoming, 0, incoming.byteLength);
        if (used === incoming.byteLength) continue;
        const tail = incoming.subarray(used);
        if (buf.byteLength < tail.byteLength) buf = new Uint8Array(grownSize(tail.byteLength));
        buf.set(tail, 0);
        end = tail.byteLength;
        continue;
      }
      const held = end - start;
      if (end + incoming.byteLength > buf.byteLength) {
        // Compact in place only while that leaves at least half the buffer
        // free; else grow to twice what is needed. Either way the next
        // compaction is at least half a buffer of input away, so each byte is
        // moved about once, and the buffer stays within a few frames.
        if (2 * (held + incoming.byteLength) <= buf.byteLength) {
          buf.copyWithin(0, start, end);
        } else {
          const next = new Uint8Array(grownSize(2 * (held + incoming.byteLength)));
          next.set(buf.subarray(start, end), 0);
          buf = next;
        }
        start = 0;
        end = held;
      }
      buf.set(incoming, end);
      end += incoming.byteLength;
      start = deliverFrames(buf, start, end);
      if (start === end) {
        start = 0;
        end = 0;
      }
    }
    if (peerClosedWrite) {
      life.abort(new Error("webrun-streams-libp2p: the peer closed the stream"));
      await closeStream(stream);
    }
  })().catch((err: unknown) => {
    // A reset ends the loop with an error, which `close` reports through
    // `signal`; a malformed frame is reported here.
    life.abort(err);
    try {
      stream.abort(err instanceof Error ? err : new Error(String(err)));
    } catch {}
  });

  /**
   * Deliver every whole frame in `bytes[from, to)`; the offset of the first
   * byte not delivered. Each message is a copy: `bytes` is this loop's buffer,
   * or a chunk whose memory libp2p may share with other frames.
   */
  function deliverFrames(bytes: Uint8Array, from: number, to: number): number {
    let at = from;
    while (at < to) {
      // The varint, inline: up to 5 bytes, malformed past that.
      let value = 0;
      let shift = 0;
      let i = at;
      let complete = false;
      while (i < to) {
        const b = bytes[i++] as number;
        // A 5th byte carries bits 28-31 only: more than that is past 32 bits.
        if (shift === 28 && b > 0x0f) {
          throw new Error("webrun-streams-libp2p: a malformed message length");
        }
        value |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) {
          complete = true;
          break;
        }
        shift += 7;
        if (shift > 28) throw new Error("webrun-streams-libp2p: a malformed message length");
      }
      if (!complete) break; // the length is not all here yet
      const length = value >>> 0;
      if (length > maxMessageBytes) {
        throw new Error(
          `webrun-streams-libp2p: a ${length}-byte message exceeds maxMessageBytes (${maxMessageBytes})`,
        );
      }
      const stop = i + length;
      if (stop > to) break;
      deliver(bytes.slice(i, stop));
      at = stop;
    }
    return at;
  }

  // Frames posted in the same task leave as one `stream.send()`: one yamux
  // frame, one Noise message, one socket write, and one window update back,
  // instead of one of each per frame (see `COALESCE_BYTES`).
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  /** A frame left since the last flush: the frames after it are gathered, and sent at the next flush (next task). */
  let gathering = false;
  /** When the first frame now in `pending` was gathered. */
  let gatheringSince = 0;
  const send = (bytes: Uint8Array): void => {
    try {
      stream.send(bytes);
    } catch {
      // The stream is closed for writing; `signal` says so.
    }
  };
  function flush(): void {
    gathering = false;
    sendPending();
  }
  function sendPending(): void {
    if (pending.length === 0) return;
    const frames = pending;
    const total = pendingBytes;
    pending = [];
    pendingBytes = 0;
    if (frames.length === 1) {
      send(frames[0] as Uint8Array);
      return;
    }
    const batch = new Uint8Array(total);
    let at = 0;
    for (const frame of frames) {
      batch.set(frame, at);
      at += frame.byteLength;
    }
    send(batch);
  }

  return {
    signal: life.signal,
    target: {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message) {
        const payload = toBytes(message);
        const n = payload.byteLength;
        const headerBytes =
          n < 0x80 ? 1 : n < 0x4000 ? 2 : n < 0x200000 ? 3 : n < 0x10000000 ? 4 : 5;
        const frame = new Uint8Array(headerBytes + n);
        let v = n;
        let i = 0;
        while (v >= 0x80) {
          frame[i++] = (v & 0x7f) | 0x80;
          v >>>= 7;
        }
        frame[i] = v;
        frame.set(payload, headerBytes);
        if (!gathering) {
          // The first frame since the last flush leaves at once, so a lone
          // message (a ping, a request in a quiet moment) waits for nothing;
          // the ones that follow it before the next flush (on the next task)
          // are gathered.
          gathering = true;
          nextTask(flush);
          send(frame);
          return;
        }
        if (
          pendingBytes + frame.byteLength > COALESCE_BYTES ||
          (pending.length > 0 && performance.now() - gatheringSince >= GATHER_MS)
        ) {
          sendPending();
        }
        if (frame.byteLength >= COALESCE_BYTES) {
          send(frame);
          return;
        }
        if (pending.length === 0) gatheringSince = performance.now();
        pending.push(frame);
        pendingBytes += frame.byteLength;
      },
      async close() {
        listeners.clear();
        sendPending();
        await closeStream(stream);
      },
      get bufferedAmount() {
        return stream.writeBufferLength + pendingBytes;
      },
      whenDrained() {
        if (!stream.writableNeedsDrain || life.signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const done = (): void => {
            stream.removeEventListener("drain", done);
            stream.removeEventListener("close", done);
            resolve();
          };
          stream.addEventListener("drain", done);
          stream.addEventListener("close", done);
        });
      },
    },
  };
}

/**
 * What frames posted in one task are gathered into before they go out as one
 * `stream.send()`: just under one Noise message (65519 bytes of payload) less
 * a yamux header, so a batch is one yamux frame, one Noise message and one
 * socket write. A frame this large or larger goes out on its own. Gathering
 * waits for the next task at most, never for more data, and for
 * {@link GATHER_MS} at most within a long task.
 */
const COALESCE_BYTES = 65_519 - 12 - 3;

/**
 * How long a gathered frame may wait within one task: the next frame posted
 * after that sends it (and what was gathered with it) at once.
 *
 * WHY (#56). A burst of exchanges whose requests arrive in one read is served
 * in one task, its handlers running in microtasks. Gathered until the task
 * ended, every answer of the burst left in one write after the last was
 * written, so the first answer waited for the last, the caller's next
 * requests came back as one burst, and the burst never broke up: K exchanges
 * in lock-step rounds, each a round trip plus the whole burst's CPU on both
 * sides. On a 100 ms link 100 concurrent 256 B exchanges ran at 474/s with
 * unbounded gathering and 687/s with this bound (`scripts/bench-mux-net.mjs`,
 * `longfat`). Bulk frames fill a batch long before this, and back-to-back
 * posts (the pump's) are still gathered.
 */
const GATHER_MS = 1;

/**
 * Runs `fn` on a later task, never a microtask: the mux's pump posts each
 * frame from a microtask, so a microtask flush would send them one by one.
 * `setImmediate` where it exists; elsewhere a `MessageChannel`, because nested
 * `setTimeout`s are clamped to 4 ms in browsers.
 */
const nextTask: (fn: () => void) => void =
  typeof globalThis.setImmediate === "function"
    ? (fn) => {
        globalThis.setImmediate(fn);
      }
    : (() => {
        let channel: MessageChannel | undefined;
        const queue: (() => void)[] = [];
        return (fn: () => void) => {
          if (channel == null) {
            channel = new MessageChannel();
            channel.port1.onmessage = () => queue.shift()?.();
          }
          queue.push(fn);
          channel.port2.postMessage(0);
        };
      })();

/** A buffer for `needed` bytes: a power of two, at least 64 KiB, so refills rarely reallocate. */
function grownSize(needed: number): number {
  let size = 64 * 1024;
  while (size < needed) size *= 2;
  return size;
}

/** A stream chunk (a `Uint8Array` or a `Uint8ArrayList`) as bytes. */
function toBytes(item: unknown): Uint8Array {
  if (item instanceof Uint8Array) return item;
  const asList = item as { subarray?: () => Uint8Array };
  if (typeof asList.subarray === "function") return asList.subarray();
  return new Uint8Array(0);
}

/** Close gracefully, or reset when that does not finish in time. */
async function closeStream(stream: Stream): Promise<void> {
  try {
    await stream.close({ signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) });
  } catch (err) {
    try {
      stream.abort(err instanceof Error ? err : new Error(String(err)));
    } catch {}
  }
}
