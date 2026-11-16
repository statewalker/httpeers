/**
 * A RESPONSE MAY END BEFORE ITS REQUEST DOES. A handler that answers without
 * reading the request body (a 413, a 401 before an upload) ends the exchange:
 * the caller gets the response, and the rest of its body is abandoned rather
 * than sent to a handler that will never read it. With an endless body this
 * is the difference between an answer and a hung call.
 *
 * Since `webrun-streams-libp2p` 0.7 the per-exchange path runs each call as a
 * port on its windowed native-port mux, where a call ends with the handler's
 * output; its deprecated protocol (0.6 and older) dropped input the handler
 * never started to read. This holds the answer on both. Runs on both paths (`vitest.config.ts`). Loopback TCP, real Noise and yamux.
 */

import { tcp } from "@libp2p/tcp";
import type { FetchHandler, PeerIdStr } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import { createNode, createRemote, serveTransport } from "../src/transport.js";
import { MUX_PER_PEER, MUX_PER_PEER_OPTION } from "./exchange-path-option.js";

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
  started.push(
    await serveTransport({ node: serverNode, dispatch, muxPerPeer: MUX_PER_PEER_OPTION }),
  );
  await clientNode.dial(serverNode.getMultiaddrs()[0]);
  const remote = createRemote({ node: clientNode, muxPerPeer: MUX_PER_PEER_OPTION });
  return { remote, target: serverNode.peerId.toString() as PeerIdStr };
}

/** A request body that never ends: 16 KiB chunks for as long as anyone pulls. */
function endlessBody(): { body: ReadableStream<Uint8Array>; cancelled: Promise<void> } {
  let onCancel = () => {};
  const cancelled = new Promise<void>((resolve) => {
    onCancel = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(16 * 1024));
    },
    cancel() {
      onCancel();
    },
  });
  return { body, cancelled };
}

describe(`a response that ends before its request (${MUX_PER_PEER ? "mux per peer" : "stream per exchange"})`, () => {
  it("a handler that never reads an endless body answers, and the caller reads the answer", async () => {
    const { remote, target } = await pair(async () => new Response("too large", { status: 413 }));
    const { body } = endlessBody();
    const response = await remote(
      target,
      new Request("http://peer.local/upload", { method: "POST", body, duplex: "half" } as never),
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("too large");
  }, 20_000);
});
