/**
 * Round trips on the mux path (#56): what an exchange costs in round trips,
 * and what the caller's presumed window ack (`mux-presumed-ack.ts`) saves.
 *
 *   - over a link that delays every message by a fixed time, an exchange
 *     whose handler reads the request to its end before answering takes ONE
 *     round trip, head and body together, where the window handshake made it
 *     two (the control runs the same exchange without the presumption);
 *   - concurrent exchanges each take that one round trip, not one after
 *     another;
 *   - an ack that contradicts the presumption, or a peer that goes silent
 *     while ports keep opening (which the mux's own keepalive no longer
 *     notices), breaks the mux;
 *   - end to end, a GET and a POST through a delaying TCP proxy, over real
 *     Noise and yamux, answer in one round trip on the mux path.
 *
 * The in-memory link delays by a fixed time per message and keeps order, so
 * the round trips are counted, not estimated. The margins are a fraction of a
 * round trip, far above the CPU an exchange takes.
 */

import net from "node:net";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  duplexOverPort,
  type MessageTarget,
  multiplexPort,
  type PortCodec,
  serveDuplexOverPort,
} from "@statewalker/webrun-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import { presumingAcks } from "../src/mux-presumed-ack.js";
import { createNode, createRemote, serveTransport } from "../src/transport.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** Two message targets joined by a link that delivers each message `delayMs` later, in order. */
function delayedLink(delayMs: number) {
  let frozen = false;
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
  };
}

const MUX = { window: 256 * 1024, frameSize: 31 * 1024 };

/**
 * A caller mux and a serving mux over `link`, as `mux-link.ts` configures
 * them. The handler reads its input to the end, then answers a head and a
 * body (two chunks), as an HTTP handler that reads the request body does.
 */
function muxPair(
  link: ReturnType<typeof delayedLink>,
  {
    presume,
    serverCodec = msgpackCodec,
    keepaliveMs = 0,
    onBroken = () => {},
  }: {
    presume: boolean;
    serverCodec?: PortCodec;
    keepaliveMs?: number;
    onBroken?: (error: Error) => void;
  },
) {
  const presumed = presume
    ? presumingAcks({ codec: msgpackCodec, target: link.caller, keepaliveMs, misses: 3, onBroken })
    : undefined;
  const keepalive = keepaliveMs > 0 ? { keepalive: { intervalMs: keepaliveMs, misses: 3 } } : {};
  const caller = multiplexPort(presumed?.target ?? link.caller, {
    codec: presumed?.codec ?? msgpackCodec,
    side: "initiator",
    ...MUX,
    ...keepalive,
  });
  const server = multiplexPort(link.server, {
    codec: serverCodec,
    side: "responder",
    ...MUX,
    ...keepalive,
    onPort: (port) => {
      serveDuplexOverPort(port, async function* (input) {
        for await (const _ of input) {
        }
        yield new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n");
        yield new Uint8Array(256);
      });
      return true;
    },
  });
  cleanup.push(async () => {
    presumed?.stop();
    await caller.close();
    await server.close();
  });
  /** One exchange: when its first chunk (the head) and its end arrived, in ms from its start. */
  const exchange = async () => {
    const started = performance.now();
    const port = await caller.openPort({ kind: "httpeers" });
    let head = Number.NaN;
    for await (const _ of duplexOverPort(port, { maxMessageSize: MUX.frameSize - 1024 })(
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

const ONE_WAY = 40;
const RTT = 2 * ONE_WAY;

describe("mux round trips", () => {
  it("answers an exchange in one round trip, head and body together, where the handshake made it two", async () => {
    const presumed = muxPair(delayedLink(ONE_WAY), { presume: true });
    const control = muxPair(delayedLink(ONE_WAY), { presume: false });
    for (let i = 0; i < 3; i++) {
      const fast = await presumed.exchange();
      expect(fast.end).toBeGreaterThanOrEqual(RTT - 1);
      expect(fast.end).toBeLessThan(1.5 * RTT);
      expect(fast.end - fast.head).toBeLessThan(0.25 * RTT);

      // Without the presumption the request's end waits for its first
      // chunk's confirmation, and the answer for the handshake's last step.
      const slow = await control.exchange();
      expect(slow.end).toBeGreaterThanOrEqual(2 * RTT - 1);
    }
  });

  it("runs concurrent exchanges side by side, each in one round trip", async () => {
    const { exchange } = muxPair(delayedLink(ONE_WAY), { presume: true });
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => exchange()));
    expect(performance.now() - started).toBeLessThan(1.5 * RTT);
    for (const r of results) expect(r.end - r.head).toBeLessThan(0.25 * RTT);
  });

  it("breaks the mux when the real ack contradicts the presumption", async () => {
    const broken: Error[] = [];
    // A responder whose codec does not read `end` acks without it.
    const { halfClose: _, ...withoutEnd } = msgpackCodec;
    const { caller } = muxPair(delayedLink(5), {
      presume: true,
      serverCodec: withoutEnd as PortCodec,
      onBroken: (error) => broken.push(error),
    });
    await caller.openPort({ kind: "httpeers" });
    await expect.poll(() => broken.length).toBe(1);
    expect(broken[0]?.message).toMatch(/acknowledged port 0/);
  });

  it("notices a peer gone silent while ports keep opening, which the presumed acks hide from the mux's keepalive", async () => {
    const link = delayedLink(2);
    const broken: Error[] = [];
    const { caller } = muxPair(link, {
      presume: true,
      keepaliveMs: 30,
      onBroken: (error) => broken.push(error),
    });
    // Alive long enough to have answered a keepalive ping.
    await new Promise((resolve) => setTimeout(resolve, 100));
    link.freeze();
    const opening = setInterval(
      () => void caller.openPort({ kind: "httpeers" }).catch(() => {}),
      10,
    );
    cleanup.push(() => clearInterval(opening));
    await expect.poll(() => broken.length, { timeout: 2000 }).toBe(1);
    expect(broken[0]?.message).toMatch(/nothing from the peer/);
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
    const oneWay = 60;
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
