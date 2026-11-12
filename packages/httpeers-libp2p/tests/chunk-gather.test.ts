/**
 * `gatheringChunks` (`chunk-gather.ts`): the pieces a producer writes back to
 * back leave as one chunk, and nothing waits for a piece not yet on its way.
 *
 *   - the five pieces of a small chunked HTTP message become one chunk, the
 *     same bytes in the same order;
 *   - a piece that comes later starts the next chunk, and the chunk before it
 *     is not held for it;
 *   - chunks stay within `maxBytes`; a larger piece passes on its own;
 *   - an error after some pieces delivers them first, then the error;
 *   - `return()` reaches the source, and does not wait for a read ahead that
 *     a quiet producer never finishes.
 */

import { describe, expect, it } from "vitest";
import { gatheringChunks } from "../src/chunk-gather.js";

const text = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of it) out.push(chunk);
  return out;
}

const joined = (chunks: Uint8Array[]) => Buffer.concat(chunks).toString("latin1");

describe("gatheringChunks", () => {
  it("joins the pieces of a small chunked HTTP message into one chunk", async () => {
    // As webrun-http-streams' codec yields a 256 B POST: head, size line,
    // body, CRLF, last chunk, each through a few async generators.
    const pieces = [
      text("POST /small HTTP/1.1\r\nHost: peer.local\r\nTransfer-Encoding: chunked\r\n\r\n"),
      text("100\r\n"),
      new Uint8Array(256).fill(7),
      text("\r\n"),
      text("0\r\n\r\n"),
    ];
    async function* body() {
      for (const piece of pieces) {
        await Promise.resolve();
        yield piece;
      }
    }
    async function* encoded() {
      yield* body();
    }
    const chunks = await collect(gatheringChunks(encoded(), 30 * 1024));
    expect(chunks).toHaveLength(1);
    expect(joined(chunks)).toBe(joined(pieces));
  });

  it("starts a new chunk with a later piece, without holding the earlier one for it", async () => {
    async function* source() {
      yield text("head");
      yield text("-body");
      await sleep(100);
      yield text("later");
    }
    const started = performance.now();
    const it = gatheringChunks(source(), 1024);
    const first = await it.next();
    // Delivered one task after its last piece, not when the late one came.
    expect(performance.now() - started).toBeLessThan(50);
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe("head-body");
    const second = await it.next();
    expect(Buffer.from(second.value as Uint8Array).toString()).toBe("later");
    expect((await it.next()).done).toBe(true);
  });

  it("keeps chunks within maxBytes, and passes a larger piece on its own", async () => {
    const pieces = [10, 10, 10, 5, 50, 10].map((n, i) => new Uint8Array(n).fill(i));
    async function* source() {
      yield* pieces;
    }
    const chunks = await collect(gatheringChunks(source(), 32));
    expect(chunks.map((c) => c.byteLength)).toEqual([30, 5, 50, 10]);
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat(pieces));
  });

  it("delivers the pieces before an error, then the error", async () => {
    async function* source() {
      yield text("a");
      yield text("b");
      throw new Error("boom");
    }
    const it = gatheringChunks(source(), 1024);
    const first = await it.next();
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe("ab");
    await expect(it.next()).rejects.toThrow("boom");
    expect((await it.next()).done).toBe(true);
  });

  it("returns at once while a read ahead waits on a quiet producer, and the source still learns of it", async () => {
    let release: (() => void) | undefined;
    let finished = false;
    async function* source() {
      try {
        yield text("event: one\n\n");
        // A quiet SSE stream: the next event may never come.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield text("event: two\n\n");
      } finally {
        finished = true;
      }
    }
    const it = gatheringChunks(source(), 1024);
    const first = await it.next();
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe("event: one\n\n");
    // The read ahead is pending inside the source; return() does not wait.
    const result = await Promise.race([it.return(undefined), sleep(500).then(() => "held")]);
    expect(result).toEqual({ done: true, value: undefined });
    expect((await it.next()).done).toBe(true);
    // The source runs its cleanup once its pending step settles.
    release?.();
    await expect.poll(() => finished).toBe(true);
  });

  it("returns through to a source with nothing read ahead", async () => {
    let finished = false;
    const source = {
      next: async () => ({ done: false as const, value: text("x") }),
      return: async () => {
        finished = true;
        return { done: true as const, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return source;
      },
    };
    const it = gatheringChunks(source, 1);
    await it.next(); // one piece of maxBytes: nothing read ahead
    await it.return(undefined);
    expect(finished).toBe(true);
  });
});
