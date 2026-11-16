/**
 * THE ADAPTIVE WINDOW (#128), end to end: the mux's default per-port window
 * follows about one bandwidth-delay product instead of a fixed 256 KiB.
 *
 * Through a TCP proxy that delays every chunk (RTT 50 ms, no rate limit, over
 * real Noise and yamux), one bulk download:
 *
 *   - with a fixed 256 KiB window (`window: 262144`) is capped near one window
 *     per round trip, about 5 MB/s;
 *   - with the default adaptive window grows past that, since the path has
 *     room and the round trip does not inflate.
 *
 * The control keeps `window: <number>` meaning a fixed window. Interop with
 * httpeers-libp2p 0.5 (which does not resize) is `mux-interop-0-5.test.ts`,
 * which runs on the defaults; the tuning itself is unit-tested in webrun-rpc.
 */

import net from "node:net";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import type { MuxPerPeer } from "../src/mux-link.js";
import {
  DEFAULT_MUX_ADAPTIVE_WINDOW,
  DEFAULT_MUX_WINDOW,
  libp2pMuxLink,
  resolveMuxWindow,
} from "../src/mux-link.js";
import { createNode, createRemote, serveTransport } from "../src/transport.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const ONE_WAY_MS = 25;
const TOTAL = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;

/** Answers any request with `TOTAL` bytes, streamed in 64 KiB chunks. */
const bulk = async (): Promise<Response> => {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= TOTAL) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(CHUNK));
      sent += CHUNK;
    },
  });
  return new Response(body);
};

/** A proxy that delays every chunk by `oneWayMs` each way, without limiting the rate. */
async function delayingProxy(targetPort: number, oneWayMs: number): Promise<number> {
  const sockets = new Set<net.Socket>();
  const pipe = (from: net.Socket, to: net.Socket) => {
    from.on("data", (chunk) => {
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, oneWayMs);
    });
    from.on("end", () => setTimeout(() => to.end(), oneWayMs + 1));
    from.on("error", () => to.destroy());
    from.on("close", () => setTimeout(() => to.destroy(), oneWayMs + 1));
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    for (const s of [client, upstream]) {
      s.setNoDelay(true);
      sockets.add(s);
    }
    pipe(client, upstream);
    pipe(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return (server.address() as net.AddressInfo).port;
}

/** Bytes per second of one `TOTAL`-byte download on the mux with `muxPerPeer`. */
async function download(muxPerPeer: MuxPerPeer): Promise<number> {
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
  cleanup.push(await serveTransport({ node: serverNode, muxPerPeer, dispatch: bulk }));
  const port = Number(serverNode.getMultiaddrs()[0]?.toString().split("/")[4]);
  const proxied = await delayingProxy(port, ONE_WAY_MS);
  await clientNode.dial(multiaddr(`/ip4/127.0.0.1/tcp/${proxied}/p2p/${serverNode.peerId}`));
  const remote = createRemote({ node: clientNode, muxPerPeer });
  const target = serverNode.peerId.toString() as PeerIdStr;
  // Warm up: the mux stream and the first port's handshake are not the window.
  await (await remote(target, new Request("http://peer.local/warm"))).body?.cancel();
  const started = performance.now();
  const response = await remote(target, new Request("http://peer.local/bulk"));
  let got = 0;
  const reader = response.body?.getReader();
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    got += r.value.byteLength;
  }
  expect(got).toBe(TOTAL);
  return got / ((performance.now() - started) / 1000);
}

describe("the adaptive mux window (#128)", () => {
  it("is the default, and starts where the fixed one did", () => {
    expect(DEFAULT_MUX_ADAPTIVE_WINDOW.initial).toBe(DEFAULT_MUX_WINDOW);
    expect(DEFAULT_MUX_ADAPTIVE_WINDOW.min).toBeLessThanOrEqual(DEFAULT_MUX_WINDOW);
    expect(DEFAULT_MUX_ADAPTIVE_WINDOW.max).toBeGreaterThan(DEFAULT_MUX_WINDOW);
  });

  it("is not capped at one 256 KiB window per round trip, where a fixed window is", async () => {
    // One 256 KiB window per 50 ms round trip: about 5.2 MB/s.
    const capped = DEFAULT_MUX_WINDOW / ((2 * ONE_WAY_MS) / 1000);
    const fixed = await download({ window: DEFAULT_MUX_WINDOW });
    expect(fixed).toBeLessThan(1.3 * capped);
    const adaptive = await download(true);
    expect(adaptive).toBeGreaterThan(2 * capped);
  }, 60_000);
});

describe("sizing the adaptive window (resolveMuxWindow)", () => {
  const KiB = 1024;
  const MiB = 1024 * KiB;
  it("a number is a fixed window, unset is the default", () => {
    expect(resolveMuxWindow(DEFAULT_MUX_WINDOW)).toBe(DEFAULT_MUX_WINDOW);
    expect(resolveMuxWindow(undefined)).toEqual(DEFAULT_MUX_ADAPTIVE_WINDOW);
  });

  it("derives the unset fields from the ones given, so a partial object is always valid", () => {
    // Each of these, merged field by field over the defaults, broke min <= initial <= max <= budget.
    expect(resolveMuxWindow({ initial: 32 * KiB })).toEqual({
      initial: 32 * KiB,
      min: 32 * KiB,
      max: 16 * MiB,
      budget: 32 * MiB,
    });
    expect(resolveMuxWindow({ budget: 8 * MiB })).toEqual({
      initial: 256 * KiB,
      min: 64 * KiB,
      max: 8 * MiB,
      budget: 8 * MiB,
    });
    expect(resolveMuxWindow({ initial: 64 * MiB })).toEqual({
      initial: 64 * MiB,
      min: 64 * KiB,
      max: 64 * MiB,
      budget: 64 * MiB,
    });
    expect(resolveMuxWindow({ max: 128 * KiB })).toEqual({
      initial: 128 * KiB,
      min: 64 * KiB,
      max: 128 * KiB,
      budget: 32 * MiB,
    });
  });

  it("refuses sizes the user gave that contradict each other, when the link is built", () => {
    expect(() => resolveMuxWindow({ min: 1 * MiB, max: 512 * KiB })).toThrow(RangeError);
    expect(() => resolveMuxWindow({ initial: 0 })).toThrow(RangeError);
    expect(() => resolveMuxWindow(0)).toThrow(RangeError);
    expect(() =>
      libp2pMuxLink({
        // Never dialled: the sizing is checked before the link is used.
        node: {} as never,
        perExchange: {} as never,
        protocol: "/httpeers/1.0.0",
        maxInboundStreams: 512,
        options: { window: { min: 1 * MiB, max: 512 * KiB } },
      } as never),
    ).toThrow(RangeError);
  });
});
