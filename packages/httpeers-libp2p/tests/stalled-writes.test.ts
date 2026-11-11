/**
 * `droppingStalledWrites` (`mux-link.ts`) on its own, with a stand-in for the
 * port and for webrun-rpc's credit state, so each case is exact: which waits
 * count against `drainTimeoutMs`, and which never do.
 *
 * The end of the stream queued behind a full window is covered here rather
 * than end to end: to queue it without a piece past the caller's window
 * (which a close then trips the caller's own window check on), what is
 * outstanding before it must sit within one end message of the window, a
 * band of a few dozen bytes of envelope that no test should depend on.
 */

import { describe, expect, it } from "vitest";
import { droppingStalledWrites, type StallWatch } from "../src/mux-link.js";

const TIMEOUT_MS = 80;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A served port and its credit state, as the stall watch sees them. */
function stage() {
  const closed = new AbortController();
  const posted: unknown[] = [];
  const port = {
    postMessage(message: unknown) {
      posted.push(message);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const state = { buffered: 0, ready: [] as Array<() => void> };
  const rpc: StallWatch["rpc"] = {
    getPortCloseSignal: () => closed.signal,
    portBufferedAmount: () => state.buffered,
    whenPortReady: () => new Promise<void>((resolve) => state.ready.push(resolve)),
  };
  const stalls = { count: 0 };
  const watch = (it: AsyncGenerator<Uint8Array>, pieceBytes = 1024) =>
    droppingStalledWrites(it, {
      rpc,
      port: port as never,
      pieceBytes,
      timeoutMs: TIMEOUT_MS,
      onStall: () => {
        stalls.count += 1;
      },
    });
  /** The credit came back: the queue drained. */
  const drain = () => {
    state.buffered = 0;
    for (const resolve of state.ready.splice(0)) resolve();
  };
  return { closed, port, state, stalls, watch, drain };
}

async function* blocks(...items: Array<Uint8Array | number>): AsyncGenerator<Uint8Array> {
  for (const item of items) {
    if (typeof item === "number") await sleep(item);
    else yield item;
  }
}

describe("droppingStalledWrites", () => {
  it("a piece the pump cannot move on from (the caller's credit) for timeoutMs stalls, once", async () => {
    const { stalls, watch } = stage();
    const out = watch(blocks(new Uint8Array(10), new Uint8Array(10)));
    expect((await out.next()).value).toHaveLength(10);
    // The pump does not pull again: it waits on the caller.
    await sleep(TIMEOUT_MS * 3);
    expect(stalls.count).toBe(1);
  });

  it("silence inside the handler is never counted: a late first piece, a long pause between pieces", async () => {
    const { stalls, watch } = stage();
    const out = watch(
      blocks(TIMEOUT_MS * 3, new Uint8Array(1), TIMEOUT_MS * 3, new Uint8Array(1), TIMEOUT_MS),
    );
    // A prompt pump: it pulls again as soon as a piece has gone.
    while (!(await out.next()).done) {}
    await sleep(10);
    expect(stalls.count).toBe(0);
  });

  it("splits a block into pieces and times each one's wait, not the whole block's", async () => {
    const { stalls, watch } = stage();
    const out = watch(blocks(new Uint8Array(3 * 100 + 1)), 100);
    const sizes: number[] = [];
    for (;;) {
      const result = await out.next();
      if (result.done) break;
      sizes.push(result.value.byteLength);
      // Each piece waits a little over half the timeout: the block's whole
      // wait is well past it, and is not a stall.
      await sleep(TIMEOUT_MS * 0.6);
    }
    expect(sizes).toEqual([100, 100, 100, 1]);
    expect(stalls.count).toBe(0);
  });

  it("times the end of the stream while it queues for credit, and stops once the queue drains", async () => {
    // Stalled: the end stays queued.
    {
      const { state, stalls, watch } = stage();
      const out = watch(blocks(new Uint8Array(1)));
      await out.next();
      // The pump posts the end, which queues behind a full window.
      state.buffered = 40;
      expect((await out.next()).done).toBe(true);
      await sleep(TIMEOUT_MS * 3);
      expect(stalls.count).toBe(1);
    }
    // Drained in time: no stall, and no timer left behind.
    {
      const { state, stalls, watch, drain } = stage();
      const out = watch(blocks(new Uint8Array(1)));
      await out.next();
      state.buffered = 40;
      expect((await out.next()).done).toBe(true);
      await sleep(TIMEOUT_MS / 2);
      drain();
      await sleep(TIMEOUT_MS * 3);
      expect(stalls.count).toBe(0);
    }
  });

  it("an end sent as a confirmed call stalls unless the port is freed within timeoutMs", async () => {
    const confirmedEnd = {
      type: "request",
      channelName: "out",
      callId: "1",
      params: { done: true },
    };
    // Never freed: the caller withholds its handshake answer, confirmation and close.
    {
      const { port, stalls, watch } = stage();
      const out = watch(blocks(new Uint8Array(1)));
      await out.next();
      expect((await out.next()).done).toBe(true);
      port.postMessage(confirmedEnd);
      await sleep(TIMEOUT_MS * 3);
      expect(stalls.count).toBe(1);
    }
    // Freed in time (the caller confirmed and closed): no stall.
    {
      const { closed, port, stalls, watch } = stage();
      const out = watch(blocks(new Uint8Array(1)));
      await out.next();
      expect((await out.next()).done).toBe(true);
      port.postMessage(confirmedEnd);
      await sleep(TIMEOUT_MS / 2);
      closed.abort();
      await sleep(TIMEOUT_MS * 3);
      expect(stalls.count).toBe(0);
    }
    // A pipelined end is not a confirmed one: once it has left, the caller
    // may read it whenever it likes.
    {
      const { port, stalls, watch } = stage();
      const out = watch(blocks(new Uint8Array(1)));
      await out.next();
      expect((await out.next()).done).toBe(true);
      port.postMessage({ type: "webrun-rpc:chunk", channelName: "out", chunk: { done: true } });
      await sleep(TIMEOUT_MS * 3);
      expect(stalls.count).toBe(0);
    }
  });

  it("an output ended early, or a port that closes, leaves no timer running", async () => {
    {
      const { stalls, watch } = stage();
      const out = watch(blocks(new Uint8Array(1), new Uint8Array(1)));
      await out.next();
      await out.return(undefined);
      await sleep(TIMEOUT_MS * 3);
      expect(stalls.count).toBe(0);
    }
    {
      const { closed, stalls, watch } = stage();
      const out = watch(blocks(new Uint8Array(1), new Uint8Array(1)));
      await out.next();
      closed.abort();
      await sleep(TIMEOUT_MS * 3);
      expect(stalls.count).toBe(0);
    }
  });
});
