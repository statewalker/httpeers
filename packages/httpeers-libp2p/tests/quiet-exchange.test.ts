/**
 * A QUIET EXCHANGE IS NOT A STALLED ONE (#56). `drainTimeoutMs` bounds only
 * how long the serving side waits for the caller to accept more of a response
 * (a write left pending: no window credit, a full stream buffer). Plain
 * silence -- a handler that has nothing to send yet -- is never a reason to
 * drop an exchange, on either exchange path: an SSE stream that goes quiet
 * between events, or a response head that takes a while, must arrive whole.
 *
 * Runs on both paths (`vitest.config.ts`), with a short `drainTimeoutMs` and
 * pauses well past it. Loopback TCP, real Noise and yamux, nothing stubbed.
 */

import { tcp } from "@libp2p/tcp";
import type { FetchHandler, PeerIdStr } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import { createNode, createRemote, serveTransport } from "../src/transport.js";
import { MUX_PER_PEER } from "./exchange-path-option.js";

const DRAIN_TIMEOUT_MS = 300;
/** Silence well past `DRAIN_TIMEOUT_MS`: several of its periods. */
const PAUSE_MS = 4 * DRAIN_TIMEOUT_MS;

const started: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (started.length > 0)
    await started
      .pop()?.()
      .catch(() => {});
});

async function node(listen: string[] = []) {
  const created = await createNode({
    privateKey: await generateKey(),
    listen,
    transports: [tcp() as never],
  });
  started.push(async () => await created.stop());
  return created;
}

async function pair(dispatch: FetchHandler) {
  const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
  const clientNode = await node();
  const stop = await serveTransport({
    node: serverNode,
    dispatch,
    muxPerPeer: MUX_PER_PEER,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
  });
  started.push(stop);
  await clientNode.dial(serverNode.getMultiaddrs()[0]);
  const remote = createRemote({ node: clientNode, muxPerPeer: MUX_PER_PEER });
  return { remote, target: serverNode.peerId.toString() as PeerIdStr };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();

describe(`a quiet exchange is not dropped (${MUX_PER_PEER ? "mux per peer" : "stream per exchange"})`, () => {
  it("an SSE-like body: one event, silence past drainTimeoutMs, then a second event", async () => {
    const { remote, target } = await pair(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("data: one\n\n"));
              await sleep(PAUSE_MS);
              controller.enqueue(encoder.encode("data: two\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const response = await remote(target, new Request("http://peer.local/events"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  }, 30_000);

  it("a quiet response head: the handler answers only after drainTimeoutMs", async () => {
    const { remote, target } = await pair(async () => {
      await sleep(PAUSE_MS);
      return new Response("late but fine");
    });

    const response = await remote(target, new Request("http://peer.local/slow"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("late but fine");
  }, 30_000);
});
