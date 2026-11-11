/**
 * The caller's presumed window ack (`mux-presumed-ack.ts`) through the link,
 * against serving peers that break the presumption:
 *
 *   - a peer that acks otherwise (here: a codec without `end`): the exchange
 *     fails with `PeerStreamResetError`, and the next call opens a new mux
 *     that presumes nothing on that connection, so it and every later call
 *     succeed (without that, every mux to the peer would break the same way);
 *   - a peer that goes silent while calls keep opening ports, which the
 *     presumed acks hide from the mux's own keepalive: its exchanges fail
 *     with `PeerStreamResetError` within a few keepalive intervals, and the
 *     next call redials.
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

const failureOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("the presumed window ack, through the link", () => {
  it("a peer that acks otherwise fails that mux once; the next mux presumes nothing and works", async () => {
    // A codec that does not read `end`: its muxes ack without that capability.
    const { halfClose: _, ...withoutEnd } = msgpackCodec;
    const serverNode = await standIn({ codec: withoutEnd as PortCodec });
    const clientNode = await node();
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const target = serverNode.peerId.toString() as PeerIdStr;
    const remote = createRemote({ node: clientNode, muxPerPeer: true });

    const failure = await failureOf(remote(target, new Request("http://peer.local/x")));
    expect(failure).toBeInstanceOf(PeerStreamResetError);
    expect(((failure as Error).cause as Error).message).toMatch(/acknowledged port/);

    // Without the per-connection memory, every one of these would fail too.
    for (let i = 0; i < 3; i++) {
      const response = await remote(target, new Request("http://peer.local/x"));
      expect(await response.text()).toBe("hello");
    }
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

    // A call every 20 ms: each opens a port, whose presumed ack the mux's own
    // keepalive would take for a sign of life.
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
    await expect
      .poll(
        async () => (calls.length > 0 ? await Promise.race([calls[0], "pending"]) : "pending"),
        {
          timeout: 3_000,
          interval: 50,
        },
      )
      .toBeInstanceOf(PeerStreamResetError);
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
