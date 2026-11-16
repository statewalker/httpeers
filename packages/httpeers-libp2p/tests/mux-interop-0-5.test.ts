/**
 * The default path (#56, #125) between this version and httpeers-libp2p 0.5.0,
 * the last release on webrun-rpc 0.11 (webrun-streams 0.3, webrun-http-streams
 * 0.5), as published on npm (#127). A mesh upgrades one peer at a time, so a
 * caller of either version must read a serving side of the other:
 *
 *   - a GET, a small POST and a POST of several windows, echoed, each way;
 *   - concurrent exchanges on the one mux, each way;
 *   - through a delaying TCP proxy, over real Noise and yamux, a GET and a
 *     POST in ONE round trip each way: webrun-rpc 0.13 added the `"window"`
 *     capability to the ack (webrun-wire#145), and a caller that presumed an
 *     ack the older responder does not send would fail the port or fall back
 *     to the handshake's two round trips.
 *
 * Both nodes come from this version's `createNode`; only the transport on one
 * side (`createRemote` or `serveTransport`) is the published 0.5.0.
 *
 * The paths that run on `webrun-streams-libp2p`'s own `connect`/`serve` are
 * covered too, since its 0.7 moved them to a windowed native-port mux
 * (`<protocol>/ports/window`) and kept its 0.3-0.6 protocol as a deprecated
 * shim on both ends (0.5.0 runs 0.3): one stream per exchange (`muxPerPeer:
 * false`) each way, a mux caller falling back to it against a 0.5.0 serving
 * side that opted out, and the duplex protocol (`openDuplex`/`serveDuplex`)
 * each way.
 */

import net from "node:net";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import * as v05 from "httpeers-libp2p-0-5";
import { afterEach, describe, expect, it } from "vitest";
import { createDuplexMounts, openDuplex, serveDuplex } from "../src/duplex.js";
import { generateKey } from "../src/identity.js";
import { createNode, createRemote, PROTOCOL, serveTransport } from "../src/transport.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** Which version serves and which one calls. */
type Direction = "new caller, 0.5.0 serving side" | "0.5.0 caller, new serving side";
const DIRECTIONS: Direction[] = [
  "new caller, 0.5.0 serving side",
  "0.5.0 caller, new serving side",
];

/** The exchange path each side runs: `true` the mux (the default), `false` one stream per exchange. */
interface Paths {
  server: boolean;
  client: boolean;
}
const MUX: Paths = { server: true, client: true };

type Dispatch = (request: Request) => Promise<Response>;
type Call = (request: Request) => Promise<Response>;

/** Echoes a POST's body; answers a GET with 64 bytes. */
const echo: Dispatch = async (request) =>
  new Response(request.method === "POST" ? await request.arrayBuffer() : new Uint8Array(64));

/**
 * A serving node and a calling node on the mux path, one of them on 0.5.0,
 * the client dialled to the server directly or through a proxy that delays
 * every chunk by `oneWayMs`.
 */
async function pair(
  direction: Direction,
  oneWayMs = 0,
  paths: Paths = MUX,
  negotiated: string[] = [],
): Promise<Call> {
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
  recordNegotiated(clientNode, negotiated);
  const oldServes = direction === "new caller, 0.5.0 serving side";
  const stop = oldServes
    ? await v05.serveTransport({
        node: serverNode as never,
        muxPerPeer: paths.server,
        dispatch: echo,
      })
    : await serveTransport({ node: serverNode, muxPerPeer: paths.server, dispatch: echo });
  cleanup.push(stop);
  const port = Number(serverNode.getMultiaddrs()[0]?.toString().split("/")[4]);
  const dialPort = oneWayMs > 0 ? await delayingProxy(port, oneWayMs) : port;
  await clientNode.dial(multiaddr(`/ip4/127.0.0.1/tcp/${dialPort}/p2p/${serverNode.peerId}`));
  const target = serverNode.peerId.toString() as PeerIdStr;
  if (oldServes) {
    const remote = createRemote({ node: clientNode, muxPerPeer: paths.client });
    return (request) => remote(target, request);
  }
  const remote = v05.createRemote({ node: clientNode as never, muxPerPeer: paths.client });
  return (request) => remote(target as never, request);
}

/** Push the protocol of every stream `node` opens to `into`, once negotiated. */
function recordNegotiated(node: Libp2p, into: string[]): void {
  const dial = node.dialProtocol.bind(node);
  node.dialProtocol = (async (...args: Parameters<Libp2p["dialProtocol"]>) => {
    const stream = await dial(...args);
    into.push(stream.protocol ?? "");
    return stream;
  }) as Libp2p["dialProtocol"];
}

const get = () => new Request("http://peer.local/x");
const post = (bytes: Uint8Array) =>
  new Request("http://peer.local/x", { method: "POST", body: bytes });

/** `size` bytes that differ from one position to the next, so a lost or reordered chunk shows. */
function pattern(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

describe.each(DIRECTIONS)("mux interop with httpeers-libp2p 0.5.0: %s", (direction) => {
  it("answers a GET, a small POST and a POST of several windows", async () => {
    const call = await pair(direction);
    const g = await call(get());
    expect(g.status).toBe(200);
    expect((await g.arrayBuffer()).byteLength).toBe(64);

    const small = pattern(256, 1);
    const s = await call(post(small));
    expect(new Uint8Array(await s.arrayBuffer())).toEqual(small);

    // Four of the 256 KiB windows both versions grant by default.
    const large = pattern(1024 * 1024, 7);
    const l = await call(post(large));
    expect(new Uint8Array(await l.arrayBuffer())).toEqual(large);
  });

  it("runs concurrent exchanges on the one mux", async () => {
    const call = await pair(direction);
    const bodies = Array.from({ length: 8 }, (_, i) => pattern(40 * 1024 + i, i));
    const answers = await Promise.all(
      bodies.map(async (body) => new Uint8Array(await (await call(post(body))).arrayBuffer())),
    );
    answers.forEach((answer, i) => {
      expect(answer).toEqual(bodies[i]);
    });
  });

  it("answers a GET and a POST in one round trip through a delaying proxy", async () => {
    const oneWay = 100;
    const rtt = 2 * oneWay;
    const call = await pair(direction, oneWay);
    const timed = async (request: Request) => {
      const started = performance.now();
      const response = await call(request);
      const head = performance.now() - started;
      await response.arrayBuffer();
      return { head, end: performance.now() - started };
    };
    await timed(get()); // opens the mux: the stream's own negotiation
    for (const request of [get, () => post(new Uint8Array(256)), get]) {
      const { head, end } = await timed(request());
      expect(head).toBeGreaterThanOrEqual(rtt - 1);
      expect(end).toBeLessThan(1.5 * rtt);
      expect(end - head).toBeLessThan(0.25 * rtt);
    }
  });
});

/** One stream per exchange on both sides, and a mux caller against a serving side that opted out. */
const PER_EXCHANGE_CASES: Array<[string, Paths]> = [
  ["one stream per exchange on both sides", { server: false, client: false }],
  ["a mux caller, a serving side that opted out", { server: false, client: true }],
];

describe.each(DIRECTIONS)("per-exchange interop with httpeers-libp2p 0.5.0: %s", (direction) => {
  it.each(PER_EXCHANGE_CASES)(
    "%s: a GET, a small POST, a large POST, concurrent POSTs",
    async (_, paths) => {
      const negotiated: string[] = [];
      const call = await pair(direction, 0, paths, negotiated);
      const g = await call(get());
      expect(g.status).toBe(200);
      expect((await g.arrayBuffer()).byteLength).toBe(64);

      const small = pattern(256, 1);
      expect(new Uint8Array(await (await call(post(small))).arrayBuffer())).toEqual(small);

      const large = pattern(1024 * 1024, 7);
      expect(new Uint8Array(await (await call(post(large))).arrayBuffer())).toEqual(large);

      const bodies = Array.from({ length: 8 }, (_, i) => pattern(40 * 1024 + i, i));
      const answers = await Promise.all(
        bodies.map(async (body) => new Uint8Array(await (await call(post(body))).arrayBuffer())),
      );
      answers.forEach((answer, i) => {
        expect(answer).toEqual(bodies[i]);
      });
      // Both ends ran the deprecated protocol: 0.5.0 knows no other, and the
      // new end fell back to it (calling) or answered on it (serving).
      expect(new Set(negotiated)).toEqual(new Set([PROTOCOL]));
    },
  );
});

describe.each(DIRECTIONS)("duplex interop with httpeers-libp2p 0.5.0: %s", (direction) => {
  it("echoes a duplex stream both ways, with the proven peer", async () => {
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
    const oldServes = direction === "new caller, 0.5.0 serving side";
    const seen: string[] = [];
    // The same echo for both versions: each chunk back, then the peer the transport proved.
    const handler = async function* (
      input: AsyncIterable<Uint8Array>,
      ctx: { peerId: string },
    ): AsyncGenerator<Uint8Array> {
      seen.push(ctx.peerId);
      for await (const chunk of input) yield chunk;
      yield new TextEncoder().encode(`|${ctx.peerId}`);
    };
    if (oldServes) {
      const mounts = v05.createDuplexMounts();
      mounts.provide("/echo", handler as never);
      cleanup.push(await v05.serveDuplex({ node: serverNode as never, mounts }));
    } else {
      const mounts = createDuplexMounts();
      mounts.provide("/echo", handler);
      cleanup.push(await serveDuplex({ node: serverNode, mounts }));
    }
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const init = { peerId: serverNode.peerId.toString(), path: "/echo" };
    const duplex = oldServes
      ? await openDuplex({ node: clientNode, ...init })
      : await v05.openDuplex({ node: clientNode as never, ...init });
    cleanup.push(() => duplex.close());

    const sent = [pattern(1000, 3), pattern(300 * 1024, 5), pattern(10, 9)];
    async function* input() {
      yield* sent;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of duplex.call(input())) chunks.push(chunk);
    const received = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of chunks) {
      received.set(c, at);
      at += c.byteLength;
    }
    const tail = new TextEncoder().encode(`|${clientNode.peerId}`);
    const body = sent.reduce((n, c) => n + c.byteLength, 0);
    expect(received.byteLength).toBe(body + tail.byteLength);
    let offset = 0;
    for (const c of sent) {
      expect(received.subarray(offset, offset + c.byteLength)).toEqual(c);
      offset += c.byteLength;
    }
    expect(new TextDecoder().decode(received.subarray(body))).toBe(`|${clientNode.peerId}`);
    expect(seen).toEqual([clientNode.peerId.toString()]);
  });
});

/** A TCP proxy on 127.0.0.1 that delays every chunk by `oneWayMs`, each way, in order. */
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
