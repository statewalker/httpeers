/**
 * `muxTargetOverStream` (`mux-target.ts`) on its own, over a stand-in for a
 * libp2p stream, so the framing is exact: what goes out in how many sends,
 * and what comes back out of any split of the bytes.
 *
 *   - it speaks `messageTargetOverStream`'s wire format both ways (the
 *     library's function reads what it writes, and it reads what the library
 *     writes), so it interoperates with any peer using either;
 *   - frames posted in one task leave as few sends: the first at once, the
 *     rest gathered, up to 16 KiB per send;
 *   - a message split across chunks, or many in one chunk, arrives whole and
 *     in order, and the read buffer stays bounded by a frame, not by the
 *     traffic;
 *   - a length past `maxMessageBytes`, or not a varint, aborts the stream.
 */

import type { Stream } from "@libp2p/interface";
import { messageTargetOverStream } from "@statewalker/webrun-streams-libp2p";
import { describe, expect, it, vi } from "vitest";
import { muxTargetOverStream } from "../src/mux-target.js";

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

/** A stand-in stream: what it sends is recorded; what it reads is pushed by the test. */
function fakeStream() {
  const events = new EventTarget();
  const sent: Uint8Array[] = [];
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let aborted: Error | undefined;
  const stream = {
    status: "open",
    writeBufferLength: 0,
    writableNeedsDrain: false,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    send(bytes: Uint8Array) {
      sent.push(bytes.slice());
      return true;
    },
    async close() {
      ended = true;
      wake?.();
      events.dispatchEvent(Object.assign(new Event("close"), { error: undefined }));
    },
    abort(error: Error) {
      aborted = error;
      stream.status = "aborted";
      ended = true;
      wake?.();
      events.dispatchEvent(Object.assign(new Event("close"), { error }));
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as Uint8Array;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
  return {
    stream: stream as unknown as Stream,
    sent,
    /** Bytes arriving from the peer. */
    push(bytes: Uint8Array) {
      queue.push(bytes);
      wake?.();
    },
    aborted: () => aborted,
  };
}

/** Every message the target delivers, in order. */
function collect(target: {
  addEventListener(type: "message", l: (e: MessageEvent) => void): void;
}) {
  const got: Uint8Array[] = [];
  target.addEventListener("message", (event) => {
    got.push(event.data as Uint8Array);
  });
  return got;
}

const bytesOf = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

describe("muxTargetOverStream", () => {
  it("speaks messageTargetOverStream's wire format, both ways", async () => {
    const messages = [0, 1, 127, 128, 16_383, 16_384, 40_000, 70_000].map((n, i) => bytesOf(n, i));

    // Ours writes, the library reads.
    const ours = fakeStream();
    const { target: writer } = muxTargetOverStream(ours.stream, { maxMessageBytes: 1 << 20 });
    for (const m of messages) writer.postMessage(m);
    await nextTask();
    const theirs = fakeStream();
    const { target: libraryReader } = messageTargetOverStream(theirs.stream);
    const readByLibrary = collect(libraryReader);
    theirs.push(concat(ours.sent));
    await expect.poll(() => readByLibrary.length).toBe(messages.length);
    expect(readByLibrary).toEqual(messages);

    // The library writes, ours reads.
    const lib = fakeStream();
    const { target: libraryWriter } = messageTargetOverStream(lib.stream);
    for (const m of messages) libraryWriter.postMessage(m);
    const back = fakeStream();
    const { target: reader } = muxTargetOverStream(back.stream, { maxMessageBytes: 1 << 20 });
    const readByOurs = collect(reader);
    back.push(concat(lib.sent));
    await expect.poll(() => readByOurs.length).toBe(messages.length);
    expect(readByOurs).toEqual(messages);
  });

  it("sends the first frame of a task at once and gathers the rest, 16 KiB per send at most", async () => {
    const s = fakeStream();
    const { target } = muxTargetOverStream(s.stream, { maxMessageBytes: 1 << 20 });
    target.postMessage(bytesOf(10, 1));
    // The first leaves at once: a lone message waits for nothing.
    expect(s.sent).toHaveLength(1);
    // Built first: posted back to back, as the mux's pump posts them (a frame
    // posted a millisecond after the one gathered before it sends that one;
    // see the next test).
    const frames = Array.from({ length: 20 }, (_, i) => bytesOf(10_000, i));
    for (const frame of frames) target.postMessage(frame);
    expect(target.bufferedAmount).toBeGreaterThan(0);
    await nextTask();
    // 20 frames of ~10 KB: one each, since two would pass 16 KiB (a batch the
    // far side can decrypt only once all of it is in; see `COALESCE_BYTES`).
    expect(s.sent.length).toBe(21);
    for (const send of s.sent) expect(send.byteLength).toBeLessThanOrEqual(16 * 1024);
    // Small frames are still gathered, up to 16 KiB a send.
    s.sent.length = 0;
    const small = Array.from({ length: 101 }, (_, i) => bytesOf(1_000, i));
    // The clock held still: on a loaded machine the loop may take over the
    // millisecond after which a gathered frame leaves with the next one.
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    try {
      for (const frame of small) target.postMessage(frame);
    } finally {
      clock.mockRestore();
    }
    await nextTask();
    // The first at once, then 100 frames of 1002 bytes in batches of 16.
    expect(s.sent.map((b) => b.byteLength)).toEqual([
      1_002,
      ...Array.from({ length: 6 }, () => 16 * 1_002),
      4 * 1_002,
    ]);
    expect(target.bufferedAmount).toBe(0);

    // A frame past that size goes out on its own, after what was gathered before it.
    s.sent.length = 0;
    const [small2, small3, large] = [bytesOf(10, 2), bytesOf(10, 3), bytesOf(100_000, 4)];
    target.postMessage(small2);
    target.postMessage(small3);
    target.postMessage(large);
    await nextTask();
    expect(s.sent.map((b) => b.byteLength)).toEqual([11, 11, 100_003]);
  });

  it("does not hold a gathered frame for a long task: it leaves with the next frame posted a millisecond later", async () => {
    // A burst of exchanges served in one task (all their requests arrived in
    // one read) must not leave as one write at the end of it: the first
    // answers would wait for the last, and the next round of requests would
    // come back as one burst again (#56: the mux's lock-step rounds).
    const s = fakeStream();
    const { target } = muxTargetOverStream(s.stream, { maxMessageBytes: 1 << 20 });
    const busy = (ms: number) => {
      const until = performance.now() + ms;
      while (performance.now() < until) {}
    };
    target.postMessage(bytesOf(10, 1)); // leaves at once
    target.postMessage(bytesOf(10, 2)); // gathered
    busy(2);
    target.postMessage(bytesOf(10, 3)); // sends what waited, and is gathered
    expect(s.sent.map((b) => b[0])).toEqual([10, 10]);
    expect(s.sent.map((b) => b[1])).toEqual([1, 2]);
    await nextTask();
    expect(s.sent.map((b) => b[1])).toEqual([1, 2, 3]);
  });

  it("delivers messages whole and in order from any split of the bytes", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => bytesOf((i * 977) % 20_000, i));
    const lib = fakeStream();
    const { target: writer } = messageTargetOverStream(lib.stream);
    for (const m of messages) writer.postMessage(m);
    const wire = concat(lib.sent);

    // Byte by byte through the first few messages only: each push is a turn
    // of the read loop, and the whole run would take minutes.
    const head = concat(lib.sent.slice(0, 4)).byteLength;
    for (const [chunk, upTo] of [
      [1, head],
      [7, wire.byteLength],
      [1000, wire.byteLength],
      [16_384, wire.byteLength],
      [wire.byteLength, wire.byteLength],
    ] as const) {
      const s = fakeStream();
      const { target } = muxTargetOverStream(s.stream, { maxMessageBytes: 1 << 20 });
      const got = collect(target);
      for (let at = 0; at < upTo; at += chunk)
        s.push(wire.subarray(at, Math.min(at + chunk, upTo)));
      if (upTo < wire.byteLength) s.push(wire.subarray(upTo));
      await expect.poll(() => got.length).toBe(messages.length);
      expect(got).toEqual(messages);
    }
  });

  it("holds a buffer bounded by a frame, not by the traffic", async () => {
    // 4000 frames of 16 KiB (64 MB) in 1000-byte chunks: every chunk ends
    // inside a frame, the case where the library's buffer kept doubling.
    const frame = (() => {
      const lib = fakeStream();
      messageTargetOverStream(lib.stream).target.postMessage(bytesOf(16_384, 7));
      return lib.sent[0] as Uint8Array;
    })();
    const s = fakeStream();
    const { target } = muxTargetOverStream(s.stream, { maxMessageBytes: 1 << 20 });
    let count = 0;
    target.addEventListener("message", () => {
      count += 1;
    });
    const before = process.memoryUsage().arrayBuffers;
    let peak = 0;
    for (let i = 0; i < 4000; i++) {
      for (let at = 0; at < frame.byteLength; at += 1000) s.push(frame.subarray(at, at + 1000));
      if (i % 100 === 99) {
        await expect.poll(() => count).toBe(i + 1);
        peak = Math.max(peak, process.memoryUsage().arrayBuffers - before);
      }
    }
    expect(count).toBe(4000);
    // Generous (other allocations and GC timing), and far below the 64 MB
    // that a buffer growing with the traffic would reach.
    expect(peak).toBeLessThan(16 * 1024 * 1024);
  }, 30_000);

  it("aborts the stream on a length past maxMessageBytes, or one that is not a varint", async () => {
    {
      const s = fakeStream();
      const { signal } = muxTargetOverStream(s.stream, { maxMessageBytes: 1024 });
      s.push(Uint8Array.from([0x81, 0x08, 1, 2, 3])); // 1025
      await expect.poll(() => signal.aborted).toBe(true);
      expect(s.aborted()?.message).toMatch(/exceeds maxMessageBytes/);
    }
    {
      const s = fakeStream();
      const { signal } = muxTargetOverStream(s.stream, { maxMessageBytes: 1024 });
      s.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      await expect.poll(() => signal.aborted).toBe(true);
      expect(s.aborted()?.message).toMatch(/malformed message length/);
    }
    {
      // A 5-byte varint whose last byte sets bit 32: 2^32, which 32-bit
      // arithmetic would wrap to a length of 0 and accept.
      const s = fakeStream();
      const { target, signal } = muxTargetOverStream(s.stream, { maxMessageBytes: 1024 });
      const got = collect(target);
      s.push(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x10, 1, 2, 3]));
      await expect.poll(() => signal.aborted).toBe(true);
      expect(s.aborted()?.message).toMatch(/malformed message length/);
      expect(got).toEqual([]);
    }
    {
      // The largest 5-byte length (bits 28-31 set) is read, and refused by size.
      const s = fakeStream();
      const { signal } = muxTargetOverStream(s.stream, { maxMessageBytes: 1024 });
      s.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f]));
      await expect.poll(() => signal.aborted).toBe(true);
      expect(s.aborted()?.message).toMatch(/exceeds maxMessageBytes/);
    }
  });

  it("sends what it gathered before closing the stream", async () => {
    const s = fakeStream();
    const { target } = muxTargetOverStream(s.stream, { maxMessageBytes: 1 << 20 });
    target.postMessage(bytesOf(5, 1));
    target.postMessage(bytesOf(5, 2));
    await target.close();
    expect(concat(s.sent)).toEqual(Uint8Array.from([5, ...bytesOf(5, 1), 5, ...bytesOf(5, 2)]));
  });
});
