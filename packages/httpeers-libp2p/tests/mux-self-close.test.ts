/**
 * A mux that closes ITSELF, not through the stream's death or httpeers' own
 * `close()` (#56): webrun-rpc's keepalive, which closes a mux whose peer
 * stopped answering pings while the libp2p stream still looks alive.
 *
 *   - on the CALLER, every exchange open on that mux fails with the same
 *     `PeerStreamResetError` (cause `PeerGoneError`) a dead stream gives, not
 *     `UnknownPeerCallError`, and the next call dials a new mux instead of
 *     reusing the closed one;
 *   - on the SERVING side, a handler reading its request body sees
 *     `PeerGoneError` (not the mux's own reason), the dead session is let
 *     go, the exchange's port is released, and a new mux from the same peer
 *     is served.
 *
 * And `peerGoneFailure` on its own: only the error the mux failed a port
 * with becomes a `PeerGoneError`, never one the peer sent.
 *
 * The caller's own silence check (`mux-presumed-ack.ts`) watches the same
 * silence and would close the mux first; it is turned off here, so the mux's
 * keepalive is what fires. The far peer is a stand-in on the mux protocol
 * (webrun-rpc's `multiplexPort`, as the link runs it) that can freeze: stop
 * reading and writing, with its stream left open. Loopback TCP, real Noise
 * and yamux.
 */

import type { Libp2p, Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { type PeerIdStr, PeerStreamResetError } from "@statewalker/httpeers-core";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  duplexOverPort,
  type MessageTarget,
  multiplexPort,
  serveDuplexOverPort,
} from "@statewalker/webrun-rpc";
import { PeerGoneError } from "@statewalker/webrun-streams-libp2p";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKey } from "../src/identity.js";
import { libp2pLink } from "../src/link.js";
import {
  DEFAULT_MUX_FRAME_SIZE,
  DEFAULT_MUX_WINDOW,
  MUX_MESSAGE_HEADROOM,
  MUX_PROTOCOL,
  peerGoneFailure,
} from "../src/mux-link.js";
import { muxTargetOverStream } from "../src/mux-target.js";
import { createNode, createRemote } from "../src/transport.js";

// The caller's silence check off: the mux's own keepalive must be what closes it.
vi.mock("../src/mux-presumed-ack.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/mux-presumed-ack.js")>();
  return {
    ...original,
    presumingAcks: (init: Parameters<typeof original.presumingAcks>[0]) =>
      original.presumingAcks({ ...init, keepaliveMs: 0 }),
  };
});

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

const maxMessageSize = DEFAULT_MUX_FRAME_SIZE - 1024;

/**
 * `stream` as the mux's pipe, which stops reading and writing once `frozen()`
 * returns true; the stream itself stays open.
 */
function freezable(stream: Stream, frozen: () => boolean) {
  const { target, signal } = muxTargetOverStream(stream, {
    maxMessageBytes: DEFAULT_MUX_FRAME_SIZE + MUX_MESSAGE_HEADROOM,
  });
  const listeners = new Map<unknown, (event: MessageEvent) => void>();
  const gated = {
    addEventListener: (_: "message", l: (event: MessageEvent) => void) => {
      const g = (event: MessageEvent) => {
        if (!frozen()) l(event);
      };
      listeners.set(l, g);
      target.addEventListener("message", g);
    },
    removeEventListener: (_: "message", l: (event: MessageEvent) => void) => {
      const g = listeners.get(l);
      if (g != null) target.removeEventListener("message", g);
    },
    postMessage: (message: unknown) => {
      if (!frozen()) target.postMessage(message);
    },
    close: () => target.close(),
    get bufferedAmount() {
      return target.bufferedAmount;
    },
  };
  return { target: gated as unknown as MessageTarget, signal };
}

const failureOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a mux closed by its own keepalive", () => {
  it("fails the caller's open exchanges with PeerStreamResetError, and the next call redials", async () => {
    // A serving stand-in whose first mux stream freezes on demand.
    let freezeFirst = false;
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    let streams = 0;
    await serverNode.handle(
      MUX_PROTOCOL,
      ((stream: Stream) => {
        const n = streams++;
        const { target, signal } = freezable(stream, () => n === 0 && freezeFirst);
        multiplexPort(target, {
          codec: msgpackCodec,
          side: "responder",
          window: DEFAULT_MUX_WINDOW,
          frameSize: DEFAULT_MUX_FRAME_SIZE,
          maxMessageSize,
          signal,
          onPort: (port) => {
            serveDuplexOverPort(
              port,
              serveFetchOverDuplex(async (req) => {
                const path = new URL(req.url).pathname;
                // Never answers: the call waits for its head.
                if (path === "/hang") return new Promise<Response>(() => {});
                // Answers the head, then sends nothing: the call waits in its body.
                if (path === "/open") {
                  return new Response(new ReadableStream<Uint8Array>({ start() {} }));
                }
                return new Response("hello");
              }),
              { maxMessageSize },
            );
            return true;
          },
        });
      }) as never,
      { maxInboundStreams: 8 },
    );
    const clientNode = await node();
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const target = serverNode.peerId.toString() as PeerIdStr;
    const remote = createRemote({ node: clientNode, muxPerPeer: { keepaliveMs: 100 } });

    const first = await remote(target, new Request("http://peer.local/x"));
    expect(await first.text()).toBe("hello");
    const beforeHead = Array.from({ length: 5 }, () =>
      failureOf(remote(target, new Request("http://peer.local/hang"))),
    );
    const bodies = await Promise.all(
      Array.from({ length: 5 }, () => remote(target, new Request("http://peer.local/open"))),
    );
    const inBody = bodies.map((r) => failureOf(r.text()));
    // Long enough for the peer to have answered a keepalive ping.
    await sleep(350);
    freezeFirst = true;

    const frozenAt = performance.now();
    const failures = await Promise.all([...beforeHead, ...inBody]);
    const settledMs = performance.now() - frozenAt;
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(PeerStreamResetError);
      expect(((failure as Error).cause as Error).name).toBe("PeerGoneError");
    }
    // Three missed pings 100 ms apart, not the 30 s request timeout.
    expect(settledMs).toBeLessThan(3_000);

    // The closed mux is not reused: the next call dials a new one, which answers.
    const again = await remote(target, new Request("http://peer.local/x"));
    expect(await again.text()).toBe("hello");
    expect(streams).toBe(2);
  }, 30_000);

  it("fails a served handler's request body with PeerGoneError, drops the session, releases its port, and serves the next mux", async () => {
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    let bodyFailure: Promise<unknown> | undefined;
    const link = libp2pLink({
      node: serverNode,
      muxPerPeer: { keepaliveMs: 100 },
      // One exchange at a time on the connection: the next mux is served only
      // if the dead mux's port was released.
      maxInboundStreams: 1,
    }) as ReturnType<typeof libp2pLink> & { liveSessions(): number };
    const stop = await serveFetchOverLink({
      link,
      dispatch: async (req) => {
        if (new URL(req.url).pathname === "/upload") {
          // Reads the upload, which never ends; answers at once with a body
          // that never ends either.
          const reader = req.body?.getReader();
          bodyFailure = failureOf(
            (async () => {
              for (;;) {
                const { done } = (await reader?.read()) ?? { done: true };
                if (done) return;
              }
            })(),
          );
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("head"));
              },
            }),
          );
        }
        return new Response("hello");
      },
    });
    started.push(stop);
    const clientNode = await node();
    await clientNode.dial(serverNode.getMultiaddrs()[0]);

    /** A calling stand-in: one mux on a fresh stream, frozen on demand. */
    const callerMux = async (frozen: () => boolean) => {
      const stream = await clientNode.dialProtocol(serverNode.peerId, MUX_PROTOCOL);
      const { target, signal } = freezable(stream, frozen);
      const mux = multiplexPort(target, {
        codec: msgpackCodec,
        side: "initiator",
        window: DEFAULT_MUX_WINDOW,
        frameSize: DEFAULT_MUX_FRAME_SIZE,
        maxMessageSize,
        signal,
      });
      started.push(() => mux.close());
      return async (request: Request) => {
        const port = await mux.openPort({ kind: "httpeers" });
        return fetchOverDuplex(duplexOverPort(port, { maxMessageSize }), request);
      };
    };

    let freeze = false;
    const call = await callerMux(() => freeze);
    // An upload that sends one chunk, then nothing, and never ends.
    const upload = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("start"));
      },
    });
    const response = await call(
      new Request("http://peer.local/upload", {
        method: "POST",
        body: upload,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(200);
    expect(link.liveSessions()).toBe(1);
    // Long enough for the caller to have answered a keepalive ping.
    await sleep(350);
    freeze = true;

    expect(bodyFailure).toBeDefined();
    const failure = await Promise.race([bodyFailure, sleep(3_000).then(() => "timed out")]);
    expect((failure as Error | undefined)?.name).toBe("PeerGoneError");
    // The dead session is let go: before, a mux that closed itself stayed in
    // the link's tables (and its teardown's) for as long as the link lived.
    await expect.poll(() => link.liveSessions(), { timeout: 2_000 }).toBe(0);

    // A new mux from the same peer, on the same connection, is served: the
    // dead mux's port no longer counts against `maxInboundStreams`.
    expect(clientNode.getConnections(serverNode.peerId)).toHaveLength(1);
    const next = await callerMux(() => false);
    const hello = await next(new Request("http://peer.local/x"));
    expect(await hello.text()).toBe("hello");
    expect(link.liveSessions()).toBe(1);
  }, 30_000);
});

describe("peerGoneFailure", () => {
  const diedOf = (reason: unknown) => {
    const dead = new AbortController();
    dead.abort(reason);
    return dead.signal;
  };
  const keepalive = new Error(
    "webrun-rpc: the peer did not answer 3 keepalive pings, 100 ms apart",
  );

  it("turns the error the mux failed the port with into a PeerGoneError, once the mux died of the peer", () => {
    const mapped = peerGoneFailure(keepalive, keepalive, diedOf(new PeerGoneError()));
    expect(mapped).toBeInstanceOf(PeerGoneError);
    expect((mapped as Error).cause).toBe(keepalive);
  });

  it("leaves an error the peer sent before the death as it is", () => {
    const handlers = new Error("the handler's own");
    handlers.name = "TimeoutError";
    expect(peerGoneFailure(handlers, keepalive, diedOf(new PeerGoneError()))).toBe(handlers);
  });

  it("leaves everything as it is while the session lives, or after a close on purpose", () => {
    expect(peerGoneFailure(keepalive, keepalive, new AbortController().signal)).toBe(keepalive);
    const closed = new Error("httpeers-libp2p: the link was closed");
    expect(peerGoneFailure(closed, closed, diedOf(closed))).toBe(closed);
  });

  it("leaves a PeerGoneError, and a port the peer closed, as they are", () => {
    const gone = new PeerGoneError();
    expect(peerGoneFailure(gone, gone, diedOf(gone))).toBe(gone);
    const peerClosed = new Error("webrun-rpc: the peer closed the port");
    expect(peerGoneFailure(peerClosed, peerClosed, diedOf(new PeerGoneError()))).toBe(peerClosed);
  });
});
