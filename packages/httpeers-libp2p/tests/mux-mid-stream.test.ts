/**
 * Events in the middle of a response on the mux path (#56), end to end over
 * real Noise and yamux: joining the pieces a producer writes back to back
 * (`chunk-gather.ts`) must not hold a piece written after a pause for the
 * next one, nor for the end of the body. An SSE-style response writes an
 * event, pauses, writes another, pauses, ends; each event reaches the caller
 * within about 100 ms of being written (on loopback it is a few ms).
 */

import { tcp } from "@libp2p/tcp";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import { createNode, createRemote, serveTransport } from "../src/transport.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mid-stream events on the mux path", () => {
  it("delivers each event within about 100 ms of its write, not with the next one or the end", async () => {
    const serverNode = await createNode({
      privateKey: await generateKey(),
      listen: ["/ip4/127.0.0.1/tcp/0"],
      transports: [tcp() as never],
    });
    const clientNode = await createNode({
      privateKey: await generateKey(),
      transports: [tcp() as never],
    });
    cleanup.push(
      () => serverNode.stop(),
      () => clientNode.stop(),
    );
    /** When each event was written, by its text. The two processes share a clock: one process. */
    const writtenAt = new Map<string, number>();
    const encoder = new TextEncoder();
    const stop = await serveTransport({
      node: serverNode,
      muxPerPeer: true,
      dispatch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const event of ["one", "two", "three"]) {
                await sleep(300);
                writtenAt.set(event, performance.now());
                controller.enqueue(encoder.encode(`data: ${event}\n\n`));
              }
              await sleep(300);
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    cleanup.push(stop);
    await clientNode.dial(serverNode.getMultiaddrs()[0] as never);
    const remote = createRemote({ node: clientNode, muxPerPeer: true });
    const response = await remote(
      serverNode.peerId.toString() as PeerIdStr,
      new Request("http://peer.local/events"),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const arrivedAt = new Map<string, number>();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      for (const match of text.matchAll(/data: (\w+)\n\n/g)) {
        const event = match[1] as string;
        if (!arrivedAt.has(event)) arrivedAt.set(event, performance.now());
      }
    }
    expect([...arrivedAt.keys()]).toEqual(["one", "two", "three"]);
    for (const event of ["one", "two", "three"]) {
      const delay = (arrivedAt.get(event) as number) - (writtenAt.get(event) as number);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(100);
    }
  });
});
