/**
 * What a small exchange costs on the wire on the mux path (#56), end to end
 * over real Noise and yamux, counted by a TCP proxy between the two nodes.
 *
 * The HTTP codec writes a 256 B POST, and its echo, in five pieces each (the
 * head, a size line, the body, a CRLF, the last chunk). Sent as one
 * `duplexOverPort` message each, every piece carried about 85 bytes of
 * envelope, and an exchange took about 1.2 KB on the wire towards the server
 * and 1.14 KB back, where the per-exchange path takes about 0.85 KB and 0.8 KB:
 * on a link where TCP's window is the limit (1% and 3% loss) the rate is
 * bytes per round trip over bytes per exchange, and the mux fell behind at
 * K=100. `chunk-gather.ts` joins the pieces (about 0.82 KB and 0.73 KB); the
 * bounds below sit between before and after, with room for timing (an extra
 * Noise message is 18 bytes).
 */

import net from "node:net";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import { createNode, createRemote, serveTransport } from "../src/transport.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A TCP proxy on 127.0.0.1 that counts the bytes each way. */
async function countingProxy(targetPort: number) {
  const counts = { toServer: 0, toCaller: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    for (const s of [client, upstream]) {
      s.setNoDelay(true);
      sockets.add(s);
      s.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (chunk: Buffer) => {
      counts.toServer += chunk.byteLength;
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      counts.toCaller += chunk.byteLength;
      client.write(chunk);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { port: (server.address() as net.AddressInfo).port, counts };
}

/** Bytes on the wire per 256 B POST exchange (echoed), each way, on one path. */
async function bytesPerExchange(muxPerPeer: boolean) {
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
  const stop = await serveTransport({
    node: serverNode,
    muxPerPeer,
    dispatch: async (request) => new Response(await request.arrayBuffer()),
  });
  cleanup.push(stop);
  const port = Number(serverNode.getMultiaddrs()[0]?.toString().split("/")[4]);
  const proxy = await countingProxy(port);
  await clientNode.dial(multiaddr(`/ip4/127.0.0.1/tcp/${proxy.port}/p2p/${serverNode.peerId}`));
  const target = serverNode.peerId.toString() as PeerIdStr;
  const remote = createRemote({ node: clientNode, muxPerPeer });
  const exchange = async () => {
    const response = await remote(
      target,
      new Request("http://peer.local/small", { method: "POST", body: new Uint8Array(256) }),
    );
    expect((await response.arrayBuffer()).byteLength).toBe(256);
  };
  // Open the mux (or warm the protocol up), and let identify settle.
  await exchange();
  await exchange();
  await sleep(300);
  const before = { ...proxy.counts };
  const n = 20;
  for (let i = 0; i < n; i++) await exchange();
  // The last exchange's trailing credit and end.
  await sleep(300);
  return {
    toServer: (proxy.counts.toServer - before.toServer) / n,
    toCaller: (proxy.counts.toCaller - before.toCaller) / n,
  };
}

describe("bytes on the wire per small exchange", () => {
  it("the mux joins the HTTP codec's pieces: no more bytes than the per-exchange path, not 1.4 times as many", async () => {
    const mux = await bytesPerExchange(true);
    const perExchange = await bytesPerExchange(false);
    // Measured: the mux about 820 and 730 bytes after, 1200 and 1140 before;
    // the per-exchange path about 855 and 800.
    expect(mux.toServer).toBeLessThan(1000);
    expect(mux.toCaller).toBeLessThan(950);
    expect(mux.toServer).toBeLessThan(1.1 * perExchange.toServer);
    expect(mux.toCaller).toBeLessThan(1.1 * perExchange.toCaller);
  });
});
