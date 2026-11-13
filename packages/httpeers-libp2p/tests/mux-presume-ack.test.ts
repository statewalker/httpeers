/**
 * The caller presumes each port's window ack (webrun-rpc's `presumeAck:
 * "always"`, set by `mux-link.ts`), through the link, against serving peers
 * that do not ack as presumed or stop answering:
 *
 *   - a peer that acks without `end` (a codec without half-close) acks what
 *     matters to the presumption, exact sizing and `pipeline`: every call
 *     succeeds;
 *   - a peer that acks otherwise (here: without exact sizing) fails at most
 *     the first exchange, the one that relied on the presumption, with
 *     `PeerStreamResetError`; the mux lives on, presumes nothing more, and
 *     every later call on it succeeds;
 *   - a peer that goes silent while calls keep opening ports: the mux's
 *     keepalive counts only what really arrives, never a presumed ack, so
 *     its exchanges fail with `PeerStreamResetError` within a few keepalive
 *     intervals, and the next call redials.
 *
 * The serving peer is a stand-in: webrun-rpc's `multiplexPort` and
 * `serveFetchOverDuplex` on the mux protocol, as the link serves it, with the
 * one difference each test needs. Loopback TCP, real Noise and yamux.
 */

import type { Libp2p, Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { type PeerIdStr, PeerStreamResetError } from "@statewalker/httpeers-core";
import { serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  type MessageTarget,
  multiplexPort,
  type PortCodec,
  serveDuplexOverPort,
} from "@statewalker/webrun-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import {
  DEFAULT_MUX_FRAME_SIZE,
  DEFAULT_MUX_WINDOW,
  MUX_MESSAGE_HEADROOM,
  MUX_PROTOCOL,
} from "../src/mux-link.js";
import { muxTargetOverStream } from "../src/mux-target.js";
import { createNode, createRemote } from "../src/transport.js";

const started: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (started.length > 0)
    await started
      .pop()?.()
      .catch(() => {});
});

async function node(listen: string[] = []): Promise<Libp2p> {
  const created = await createNode({
    privateKey: await generateKey(),
    listen,
    transports: [tcp() as never],
  });
  started.push(async () => await created.stop());
  return created;
}

/**
 * A serving peer on the mux protocol that answers every request "hello".
 * `codec` is what its muxes speak; `frozen(n)` makes its n-th mux stream (from
 * 0) stop reading and writing once it returns true.
 */
async function standIn({
  codec = msgpackCodec,
  frozen = () => false,
}: {
  codec?: PortCodec;
  frozen?: (n: number) => boolean;
}) {
  const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
  let streams = 0;
  muxStreams = () => streams;
  await serverNode.handle(
    MUX_PROTOCOL,
    ((stream: Stream) => {
      const n = streams++;
      const { target, signal } = muxTargetOverStream(stream, {
        maxMessageBytes: DEFAULT_MUX_FRAME_SIZE + MUX_MESSAGE_HEADROOM,
      });
      const listeners = new Map<unknown, (event: MessageEvent) => void>();
      const gated = {
        addEventListener: (_: "message", l: (event: MessageEvent) => void) => {
          const g = (event: MessageEvent) => {
            if (!frozen(n)) l(event);
          };
          listeners.set(l, g);
          target.addEventListener("message", g);
        },
        removeEventListener: (_: "message", l: (event: MessageEvent) => void) => {
          const g = listeners.get(l);
          if (g != null) target.removeEventListener("message", g);
        },
        postMessage: (message: unknown) => {
          if (!frozen(n)) target.postMessage(message);
        },
        close: () => target.close(),
        get bufferedAmount() {
          return target.bufferedAmount;
        },
      };
      const maxMessageSize = DEFAULT_MUX_FRAME_SIZE - 1024;
      multiplexPort(gated as unknown as MessageTarget, {
        codec,
        side: "responder",
        window: DEFAULT_MUX_WINDOW,
        frameSize: DEFAULT_MUX_FRAME_SIZE,
        maxMessageSize,
        signal,
        onPort: (port) => {
          serveDuplexOverPort(
            port,
            serveFetchOverDuplex(async () => new Response("hello")),
            { maxMessageSize },
          );
          return true;
        },
      });
    }) as never,
    { maxInboundStreams: 8 },
  );
  return serverNode;
}

/** Mux streams the last stand-in accepted. */
let muxStreams = () => 0;

const failureOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("the presumed window ack, through the link", () => {
  it("a peer that acks without half-close answers every call", async () => {
    const { halfClose: _, ...withoutEnd } = msgpackCodec;
    const serverNode = await standIn({ codec: withoutEnd as PortCodec });
    const clientNode = await node();
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const target = serverNode.peerId.toString() as PeerIdStr;
    const remote = createRemote({ node: clientNode, muxPerPeer: true });
    for (let i = 0; i < 4; i++) {
      const response = await remote(target, new Request("http://peer.local/x"));
      expect(await response.text()).toBe("hello");
    }
    expect(muxStreams()).toBe(1);
  }, 30_000);

  it("a peer that acks otherwise fails at most the first exchange; the mux lives on and answers the rest", async () => {
    // A codec that cannot count exact bytes: its muxes ack without `exact`.
    const { encode: _e, decode: _d, ...inexact } = msgpackCodec;
    const serverNode = await standIn({ codec: inexact as PortCodec });
    const clientNode = await node();
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const target = serverNode.peerId.toString() as PeerIdStr;
    const remote = createRemote({ node: clientNode, muxPerPeer: true });

    const failure = await failureOf(remote(target, new Request("http://peer.local/x")));
    expect(failure).toBeInstanceOf(PeerStreamResetError);
    const cause = (failure as Error).cause as Error;
    expect(cause.name).toBe("MuxPortClosedError");
    expect((cause.cause as Error).message).toMatch(/acknowledged port/);

    for (let i = 0; i < 3; i++) {
      const response = await remote(target, new Request("http://peer.local/x"));
      expect(await response.text()).toBe("hello");
    }
    // The same mux: a contradiction closes no mux.
    expect(muxStreams()).toBe(1);
  }, 30_000);

  it("a peer gone silent while calls keep opening ports fails its exchanges, and the next call redials", async () => {
    let freezeFirst = false;
    const serverNode = await standIn({ frozen: (n) => n === 0 && freezeFirst });
    const clientNode = await node();
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const target = serverNode.peerId.toString() as PeerIdStr;
    const remote = createRemote({ node: clientNode, muxPerPeer: { keepaliveMs: 100 } });

    const first = await remote(target, new Request("http://peer.local/x"));
    expect(await first.text()).toBe("hello");
    // Long enough for the peer to have answered a keepalive ping.
    await new Promise((resolve) => setTimeout(resolve, 350));
    freezeFirst = true;

    // A call every 20 ms: each opens a port and presumes its ack, which must
    // not count as the peer answering.
    const calls: Promise<unknown>[] = [];
    const opening = setInterval(() => {
      calls.push(
        // A body cut short (at teardown) settles here too, never unhandled.
        remote(target, new Request("http://peer.local/x"))
          .then((r) => r.text())
          .catch((e: unknown) => e),
      );
    }, 20);
    started.push(async () => clearInterval(opening));
    // Three silent intervals of 100 ms and a little: about 0.4-0.9 s. A mux
    // that took the presumed acks for signs of life would take well over a
    // second, by some other way than its keepalive.
    await expect
      .poll(
        async () => (calls.length > 0 ? await Promise.race([calls[0], "pending"]) : "pending"),
        {
          timeout: 1_200,
          interval: 25,
        },
      )
      .toBeInstanceOf(PeerStreamResetError);
    // And it was the keepalive that closed it.
    const failure = (await calls[0]) as Error;
    const gone = failure.cause as Error;
    expect(gone.name).toBe("PeerGoneError");
    expect((gone.cause as Error | undefined)?.message).toMatch(/did not answer 3 keepalive pings/);
    // The next call dials a new mux, which answers.
    await expect
      .poll(
        async () => {
          const response = await remote(target, new Request("http://peer.local/x"));
          return response.text();
        },
        { timeout: 5_000 },
      )
      .toBe("hello");
    clearInterval(opening);
  }, 30_000);
});
