/**
 * A serving peer that dies mid-body.
 *
 * `webrun-streams-libp2p` >= 0.2 ends such a call with `PeerGoneError` rather
 * than a clean end of stream. The head is already in by then, so the failure
 * reaches the caller through the response BODY, not through `Remote`'s own
 * promise; `mapPeerCallError` is applied there too, and a reader must see the
 * same typed `PeerStreamResetError` a reset before the head produces, with the
 * transport's error kept as `cause`.
 */

import { tcp } from "@libp2p/tcp";
import { type PeerIdStr, PeerStreamResetError } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import { createNode, createRemote, mapPeerCallError, serveTransport } from "../src/transport.js";

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
  started.push(async () => {
    await created.stop();
  });
  return created;
}

describe("a peer that dies mid-body", () => {
  it("fails the body with PeerStreamResetError, the transport's PeerGoneError as cause", async () => {
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const clientNode = await node();
    // One chunk, then nothing: the body stays open until the node dies.
    await serveTransport({
      node: serverNode,
      dispatch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
          }),
        ),
    });
    await clientNode.dial(serverNode.getMultiaddrs()[0]);

    const remote = createRemote({ node: clientNode });
    const target = serverNode.peerId.toString() as PeerIdStr;
    const response = await remote(target, new Request("http://peer.local/stream"));
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a body");

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");

    await serverNode.stop();

    const failure = await reader.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PeerStreamResetError);
    const reset = failure as PeerStreamResetError;
    expect(reset.kind).toBe("stream-reset");
    expect(reset.peerId).toBe(target);
    expect((reset.cause as Error).name).toBe("PeerGoneError");
  }, 20_000);

  it("maps PeerGoneError by name, keeping it as cause", () => {
    const reset = new Error("stream reset");
    reset.name = "StreamResetError";
    const gone = new Error("the stream ended before the call finished", { cause: reset });
    gone.name = "PeerGoneError";

    const mapped = mapPeerCallError(gone, "12D3KooWpeer" as PeerIdStr);

    expect(mapped).toBeInstanceOf(PeerStreamResetError);
    expect(mapped.cause).toBe(gone);
    expect((mapped.cause as Error).cause).toBe(reset);
  });
});
