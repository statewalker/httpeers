/**
 * Round trips on the mux path (#56): what an exchange costs in round trips,
 * with the caller presuming each port's window ack (webrun-rpc's
 * `presumeAck: "always"`, as `mux-link.ts` sets it), and against peers built
 * on webrun-rpc 0.10.
 *
 *   - over a link that delays every message by a fixed time, an exchange
 *     whose handler reads the request to its end before answering takes ONE
 *     round trip, head and body together, where the window handshake made it
 *     two (the control runs the same exchange with `presumeAck: "never"`);
 *   - concurrent exchanges each take that one round trip, not one after
 *     another;
 *   - against a 0.10 serving peer, from the first port; a caller built on
 *     0.10 with httpeers' former presumed ack (`old-presumed-ack.ts`) gets
 *     one round trip from this serving side, and a plain 0.10 caller gets a
 *     GET's head and body together from its second port on;
 *   - a peer whose ack contradicts the presumption fails at most the port
 *     that relied on it; the mux lives on and its later ports work;
 *   - a peer gone silent while ports keep opening closes the mux (its
 *     keepalive counts only what really arrives, never a presumed ack);
 *   - end to end, a GET and a POST through a delaying TCP proxy, over real
 *     Noise and yamux, answer in one round trip on the mux path, against a
 *     serving side of this version and against a 0.10 one.
 *
 * The in-memory link delays by a fixed time per message and keeps order, so
 * the round trips are counted, not estimated. The margins are a fraction of a
 * round trip, far above the CPU an exchange takes.
 */

import net from "node:net";
import type { Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import type { MessageTarget, PortCodec } from "@statewalker/webrun-rpc";
import * as rpc from "@statewalker/webrun-rpc";
import { afterEach, describe, expect, it } from "vitest";
import * as v010 from "webrun-rpc-0-10";
import { generateKey } from "../src/identity.js";
import {
  DEFAULT_MUX_FRAME_SIZE,
  DEFAULT_MUX_WINDOW,
  MUX_MESSAGE_HEADROOM,
  MUX_PROTOCOL,
} from "../src/mux-link.js";
import { muxTargetOverStream } from "../src/mux-target.js";
import { createNode, createRemote, serveTransport } from "../src/transport.js";
import { oldPresumingAcks } from "./old-presumed-ack.js";

const cleanup: Array<() => unknown> = [];
/**
 * What the former httpeers caller (`old-presumed-ack.ts`) found wrong with a
 * real ack: a deployed one would close its mux on it, so any is a failure.
 */
const oldCallerBroken: Error[] = [];
const onOldCallerBroken = (error: Error) => {
  oldCallerBroken.push(error);
};
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
  const broken = oldCallerBroken.splice(0);
  expect(broken.map((e) => e.message)).toEqual([]);
});

/** Two message targets joined by a link that delivers each message `delayMs` later, in order. */
function delayedLink(delayMs: number) {
  let frozen = false;
  const closed: unknown[] = [];
  const end = () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let peer: typeof listeners;
    const target = {
      addEventListener: (_: "message", l: (event: MessageEvent) => void) => listeners.add(l),
      removeEventListener: (_: "message", l: (event: MessageEvent) => void) => listeners.delete(l),
      postMessage(message: unknown) {
        const data = message instanceof Uint8Array ? message.slice() : message;
        setTimeout(() => {
          if (frozen) return;
          for (const l of [...peer]) l(new MessageEvent("message", { data }));
        }, delayMs);
      },
      bufferedAmount: 0,
      close: (reason?: unknown) => {
        closed.push(reason);
      },
    };
    return { target, listeners, join: (other: typeof listeners) => (peer = other) };
  };
  const a = end();
  const b = end();
  a.join(b.listeners);
  b.join(a.listeners);
  return {
    caller: a.target as unknown as MessageTarget,
    server: b.target as unknown as MessageTarget,
    /** Nothing more is delivered, either way: a frozen peer. */
    freeze: () => {
      frozen = true;
    },
    /** The pipes their muxes released: a mux releases its pipe when it closes. */
    closed,
  };
}

const MUX = { window: 256 * 1024, frameSize: 31 * 1024 };
const maxMessageSize = MUX.frameSize - 1024;

/** Which webrun-rpc a mux runs, and how. */
type Kit = "new" | "old" | "old-presuming";

/**
 * A caller mux and a serving mux over `link`, as `mux-link.ts` configures
 * them, each on the webrun-rpc its kit names: `new` is this version
 * (presuming unless `presumeAck` says otherwise), `old` the published
 * 0.10.2, `old-presuming` 0.10.2 with the presumed ack httpeers ran before
 * 0.11 (`old-presumed-ack.ts`). The handler reads its input to the end (or
 * only its first chunk, `readAll: false`, as a GET's handler answers on the
 * head), then answers a head and a body, two chunks.
 */
function muxPair(
  link: ReturnType<typeof delayedLink>,
  {
    caller: callerKit = "new",
    server: serverKit = "new",
    presumeAck = "always",
    serverCodec = msgpackCodec,
    keepaliveMs = 0,
  }: {
    caller?: Kit;
    server?: Kit;
    presumeAck?: "always" | "never";
    serverCodec?: PortCodec;
    keepaliveMs?: number;
  } = {},
) {
  const keepalive = keepaliveMs > 0 ? { keepalive: { intervalMs: keepaliveMs, misses: 3 } } : {};
  let caller: rpc.PortMux;
  let duplexOverPort: typeof rpc.duplexOverPort;
  if (callerKit === "new") {
    caller = rpc.multiplexPort(link.caller, {
      codec: msgpackCodec,
      side: "initiator",
      presumeAck,
      ...MUX,
      ...keepalive,
    });
    duplexOverPort = rpc.duplexOverPort;
  } else {
    const wrapped =
      callerKit === "old-presuming"
        ? oldPresumingAcks(
            msgpackCodec as v010.PortCodec,
            link.caller as v010.MessageTarget,
            onOldCallerBroken,
          )
        : { codec: msgpackCodec as v010.PortCodec, target: link.caller as v010.MessageTarget };
    caller = v010.multiplexPort(wrapped.target, {
      codec: wrapped.codec,
      side: "initiator",
      ...MUX,
      ...keepalive,
    }) as unknown as rpc.PortMux;
    duplexOverPort = v010.duplexOverPort as unknown as typeof rpc.duplexOverPort;
  }
  let readAll = true;
  const handler = async function* (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    for await (const _ of input) {
      if (!readAll) break;
    }
    yield new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n");
    yield new Uint8Array(256);
  };
  const serving = serverKit === "new" ? rpc : (v010 as unknown as typeof rpc);
  const server = serving.multiplexPort(link.server, {
    codec: serverCodec,
    side: "responder",
    ...MUX,
    ...keepalive,
    onPort: (port) => {
      serving.serveDuplexOverPort(port, handler, { maxMessageSize });
      return true;
    },
  });
  cleanup.push(async () => {
    await caller.close();
    await server.close();
  });
  /**
   * One exchange: when its first chunk (the head) and its end arrived, in ms
   * from its start. `get` answers on the request's first chunk.
   */
  const exchange = async ({ get = false } = {}) => {
    readAll = !get;
    const started = performance.now();
    const port = await caller.openPort({ kind: "httpeers" });
    let head = Number.NaN;
    for await (const _ of duplexOverPort(port, { maxMessageSize })(
      (async function* () {
        yield new Uint8Array(300); // a request head and a small body
      })(),
    )) {
      if (Number.isNaN(head)) head = performance.now() - started;
    }
    return { head, end: performance.now() - started };
  };
  return { caller, server, exchange };
}

const failureOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

// Wide enough that one round trip plus the CPU of a loaded machine stays well
// under the 1.5 round trips that tell one round trip from two.
const ONE_WAY = 100;
const RTT = 2 * ONE_WAY;

/** One round trip, head and body together. */
function expectOneRoundTrip(r: { head: number; end: number }) {
  expect(r.end).toBeGreaterThanOrEqual(RTT - 1);
  expect(r.end).toBeLessThan(1.5 * RTT);
  expect(r.end - r.head).toBeLessThan(0.25 * RTT);
}

describe("mux round trips", () => {
  it("answers an exchange in one round trip, head and body together, where the handshake made it two", async () => {
    const presumed = muxPair(delayedLink(ONE_WAY));
    const control = muxPair(delayedLink(ONE_WAY), { presumeAck: "never" });
    for (let i = 0; i < 3; i++) {
      expectOneRoundTrip(await presumed.exchange());
      expectOneRoundTrip(await presumed.exchange({ get: true }));

      // Without the presumption the request's end waits for its first
      // chunk's confirmation.
      const slow = await control.exchange();
      expect(slow.end).toBeGreaterThanOrEqual(2 * RTT - 1);
    }
  });

  it("runs concurrent exchanges side by side, each in one round trip", async () => {
    const { exchange } = muxPair(delayedLink(ONE_WAY));
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => exchange()));
    expect(performance.now() - started).toBeLessThan(1.5 * RTT);
    for (const r of results) expect(r.end - r.head).toBeLessThan(0.25 * RTT);
  });

  it("takes one round trip against a serving peer on webrun-rpc 0.10, from the first port", async () => {
    const { exchange } = muxPair(delayedLink(ONE_WAY), { server: "old" });
    for (let i = 0; i < 3; i++) {
      expectOneRoundTrip(await exchange());
      expectOneRoundTrip(await exchange({ get: true }));
    }
  });

  it("serves a 0.10 caller with httpeers' former presumed ack in one round trip", async () => {
    const { exchange } = muxPair(delayedLink(ONE_WAY), { caller: "old-presuming" });
    for (let i = 0; i < 3; i++) {
      expectOneRoundTrip(await exchange());
      expectOneRoundTrip(await exchange({ get: true }));
    }
  });

  it("serves a plain 0.10 caller, a GET's head and body together from its second port on", async () => {
    const { exchange } = muxPair(delayedLink(ONE_WAY), { caller: "old" });
    // The first port runs the full handshake; its uploads wait for it.
    const first = await exchange({ get: true });
    expect(first.end).toBeLessThan(2.5 * RTT);
    for (let i = 0; i < 3; i++) {
      expectOneRoundTrip(await exchange({ get: true }));
      // Its own upload still waits for its first chunk's confirmation.
      const post = await exchange();
      expect(post.end).toBeLessThan(2.5 * RTT);
    }
  });

  it("a peer whose ack contradicts the presumption fails only the port that relied on it; the mux lives on", async () => {
    // A responder over a codec that cannot count exact bytes acks without
    // `exact`, where the caller presumed exact sizing.
    const { encode: _e, decode: _d, ...inexact } = msgpackCodec;
    const link = delayedLink(5);
    const { exchange } = muxPair(link, { serverCodec: inexact as PortCodec });
    const failure = await failureOf(exchange());
    expect((failure as Error | undefined)?.message).toMatch(/acknowledged port 0/);
    for (let i = 0; i < 3; i++) {
      const r = await exchange();
      expect(Number.isNaN(r.head)).toBe(false);
    }
    expect(link.closed).toHaveLength(0);
  });

  it("closes the mux of a peer gone silent while ports keep opening", async () => {
    const link = delayedLink(2);
    const { caller } = muxPair(link, { keepaliveMs: 30 });
    // Alive long enough to have answered a keepalive ping.
    await new Promise((resolve) => setTimeout(resolve, 100));
    link.freeze();
    // Each port takes its ack as given: none of them may count as the peer
    // answering.
    const opening = setInterval(
      () => void caller.openPort({ kind: "httpeers" }).catch(() => {}),
      10,
    );
    cleanup.push(() => clearInterval(opening));
    await expect.poll(() => link.closed.length, { timeout: 2000 }).toBeGreaterThan(0);
    await expect(caller.openPort({ kind: "httpeers" })).rejects.toThrow(/closed/);
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

describe("mux round trips end to end", () => {
  it("answers a GET and a POST in one round trip through a delaying proxy", async () => {
    const oneWay = 100;
    const rtt = 2 * oneWay;
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
      muxPerPeer: true,
      dispatch: async (request) =>
        new Response(request.method === "POST" ? await request.arrayBuffer() : new Uint8Array(64)),
    });
    cleanup.push(stop);
    const port = Number(serverNode.getMultiaddrs()[0]?.toString().split("/")[4]);
    const proxied = await delayingProxy(port, oneWay);
    await clientNode.dial(multiaddr(`/ip4/127.0.0.1/tcp/${proxied}/p2p/${serverNode.peerId}`));
    const target = serverNode.peerId.toString() as PeerIdStr;
    const remote = createRemote({ node: clientNode, muxPerPeer: true });

    const timed = async (request: () => Request) => {
      const started = performance.now();
      const response = await remote(target, request());
      const head = performance.now() - started;
      await response.arrayBuffer();
      return { head, end: performance.now() - started };
    };
    const get = () => new Request("http://peer.local/x");
    const post = () =>
      new Request("http://peer.local/x", { method: "POST", body: new Uint8Array(256) });
    await timed(get); // opens the mux
    for (const request of [get, post, get, post]) {
      const { head, end } = await timed(request);
      expect(head).toBeGreaterThanOrEqual(rtt - 1);
      expect(end).toBeLessThan(1.5 * rtt);
      expect(end - head).toBeLessThan(0.25 * rtt);
    }
  });
});

describe("mux round trips end to end, with peers on webrun-rpc 0.10", () => {
  const oneWay = 100;
  const rtt = 2 * oneWay;

  /** Two nodes, the client dialled to the server through a delaying proxy. */
  async function proxiedPair() {
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
    const dial = async () => {
      const port = Number(serverNode.getMultiaddrs()[0]?.toString().split("/")[4]);
      const proxied = await delayingProxy(port, oneWay);
      await clientNode.dial(multiaddr(`/ip4/127.0.0.1/tcp/${proxied}/p2p/${serverNode.peerId}`));
    };
    return { serverNode, clientNode, dial };
  }

  const answer = async (request: Request) =>
    new Response(request.method === "POST" ? await request.arrayBuffer() : new Uint8Array(64));
  const get = () => new Request("http://peer.local/x");
  const post = () =>
    new Request("http://peer.local/x", { method: "POST", body: new Uint8Array(256) });

  async function timed(call: (request: Request) => Promise<Response>, request: Request) {
    const started = performance.now();
    const response = await call(request);
    const head = performance.now() - started;
    await response.arrayBuffer();
    return { head, end: performance.now() - started };
  }

  it("this caller answers a GET and a POST in one round trip from a 0.10 serving side", async () => {
    const { serverNode, clientNode, dial } = await proxiedPair();
    // The serving side as httpeers built it on webrun-rpc 0.10.
    await serverNode.handle(
      MUX_PROTOCOL,
      ((stream: Stream) => {
        const { target, signal } = muxTargetOverStream(stream, {
          maxMessageBytes: DEFAULT_MUX_FRAME_SIZE + MUX_MESSAGE_HEADROOM,
        });
        const max = DEFAULT_MUX_FRAME_SIZE - 1024;
        v010.multiplexPort(target as unknown as v010.MessageTarget, {
          codec: msgpackCodec as v010.PortCodec,
          side: "responder",
          window: DEFAULT_MUX_WINDOW,
          frameSize: DEFAULT_MUX_FRAME_SIZE,
          maxMessageSize: max,
          signal,
          onPort: (port) => {
            v010.serveDuplexOverPort(port, serveFetchOverDuplex(answer) as never, {
              maxMessageSize: max,
            });
            return true;
          },
        });
      }) as never,
      { maxInboundStreams: 8 },
    );
    await dial();
    const target = serverNode.peerId.toString() as PeerIdStr;
    const remote = createRemote({ node: clientNode, muxPerPeer: true });
    const call = (request: Request) => remote(target, request);
    await timed(call, get()); // opens the mux: the stream's own negotiation
    for (const request of [get, post, get, post]) {
      const { head, end } = await timed(call, request());
      expect(head).toBeGreaterThanOrEqual(rtt - 1);
      expect(end).toBeLessThan(1.5 * rtt);
      expect(end - head).toBeLessThan(0.25 * rtt);
    }
  });

  it("this serving side answers a 0.10 caller in one round trip, with httpeers' former presumed ack, and a plain one without breaking", async () => {
    const { serverNode, clientNode, dial } = await proxiedPair();
    const stop = await serveTransport({ node: serverNode, muxPerPeer: true, dispatch: answer });
    cleanup.push(stop);
    await dial();
    /** A caller as httpeers built it on webrun-rpc 0.10: one mux on a fresh stream. */
    const oldCaller = async (presuming: boolean) => {
      const stream = await clientNode.dialProtocol(serverNode.peerId, MUX_PROTOCOL);
      const { target, signal } = muxTargetOverStream(stream, {
        maxMessageBytes: DEFAULT_MUX_FRAME_SIZE + MUX_MESSAGE_HEADROOM,
      });
      const pipe = presuming
        ? oldPresumingAcks(
            msgpackCodec as v010.PortCodec,
            target as unknown as v010.MessageTarget,
            onOldCallerBroken,
          )
        : {
            codec: msgpackCodec as v010.PortCodec,
            target: target as unknown as v010.MessageTarget,
          };
      const max = DEFAULT_MUX_FRAME_SIZE - 1024;
      const mux = v010.multiplexPort(pipe.target, {
        codec: pipe.codec,
        side: "initiator",
        window: DEFAULT_MUX_WINDOW,
        frameSize: DEFAULT_MUX_FRAME_SIZE,
        maxMessageSize: max,
        signal,
      });
      cleanup.push(() => mux.close());
      return async (request: Request) => {
        const port = await mux.openPort({ kind: "httpeers" });
        return fetchOverDuplex(
          v010.duplexOverPort(port, { maxMessageSize: max }) as never,
          request,
        );
      };
    };

    const presuming = await oldCaller(true);
    for (const request of [get, get, post, get, post]) {
      const { head, end } = await timed(presuming, request());
      expect(head).toBeGreaterThanOrEqual(rtt - 1);
      expect(end).toBeLessThan(1.5 * rtt);
      expect(end - head).toBeLessThan(0.25 * rtt);
    }

    const plain = await oldCaller(false);
    // The first port runs the full handshake.
    expect((await timed(plain, get())).end).toBeLessThan(2.5 * rtt);
    for (let i = 0; i < 2; i++) {
      // From the second port on, a GET's head and body come together.
      const g = await timed(plain, get());
      expect(g.end).toBeLessThan(1.5 * rtt);
      expect(g.end - g.head).toBeLessThan(0.25 * rtt);
      // Its own upload still waits for its first chunk's confirmation.
      const p = await timed(plain, post());
      expect(p.end).toBeLessThan(2.5 * rtt);
    }
  });
});
