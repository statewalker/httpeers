/**
 * The experimental one-mux-per-peer path (#56), on what only it promises.
 *
 * Every other test in this package also runs on this path (the `mux-per-peer`
 * project); this file checks what the per-exchange path never claimed:
 *
 *   - one stream carries every exchange with a peer, and concurrent first
 *     calls share it;
 *   - a peer that dies fails EVERY open exchange on the mux at once, before
 *     and after the response head, with the same `PeerStreamResetError` a
 *     reset stream gives; the next call dials a new mux;
 *   - a reader that stops reading holds its own port's window and nothing
 *     else: the producer stops (bounded memory) and another exchange on the
 *     same mux still answers promptly (a small head-of-line check);
 *   - old and new peers interoperate: a caller with the flag falls back to a
 *     stream per exchange for a peer without it (or fails clearly, with
 *     `fallback: false`), and a peer with the flag still serves callers
 *     without it;
 *   - the serving side keeps the per-exchange bounds: exchanges capped per
 *     connection across its muxes, an exchange whose write the caller
 *     leaves blocked dropped after `drainTimeoutMs` (a merely quiet one is
 *     not: `quiet-exchange.test.ts`), an oversized message refused;
 *   - a link that finds every mux stream taken falls back;
 *   - teardown lets go of the mux.
 *
 * Loopback TCP, real Noise and yamux, nothing stubbed.
 */

import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import {
  createMounts,
  type FetchHandler,
  type PeerIdStr,
  PeerProtocolUnsupportedError,
  PeerStreamResetError,
} from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import {
  DEFAULT_MUX_FRAME_SIZE,
  DEFAULT_MUX_WINDOW,
  MUX_MAX_STREAMS_PER_CONNECTION,
  MUX_MESSAGE_HEADROOM,
  MUX_PROTOCOL,
  type MuxPerPeer,
} from "../src/mux-link.js";
import { servePeer } from "../src/serve-peer.js";
import { createNode, createRemote, PROTOCOL, serveTransport } from "../src/transport.js";

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

/** A served node and a client node already connected to it. */
async function pair(
  dispatch: FetchHandler,
  serveMux: MuxPerPeer | undefined = true,
  serving: Partial<Parameters<typeof serveTransport>[0]> = {},
) {
  const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
  const clientNode = await node();
  const stop = await serveTransport({
    node: serverNode,
    dispatch,
    muxPerPeer: serveMux,
    ...serving,
  });
  started.push(stop);
  await clientNode.dial(serverNode.getMultiaddrs()[0]);
  return { serverNode, clientNode, target: serverNode.peerId.toString() as PeerIdStr };
}

function streamsOn(from: Libp2p, to: Libp2p, protocol: string): number {
  return from
    .getConnections(to.peerId)
    .flatMap((c) => c.streams)
    .filter((s) => s.protocol === protocol).length;
}

/** Dispatch on the request's path, as the router does for local mounts. */
const route =
  (mounts: ReturnType<typeof createMounts>): FetchHandler =>
  async (req) =>
    (mounts.match(new URL(req.url).pathname) ?? (async () => new Response(null, { status: 404 })))(
      req,
    );

/** A body that never ends and never sends: the call stays open. */
const openBody = () => new Response(new ReadableStream<Uint8Array>({ start() {} }));

/** An unsigned LEB128 varint, as the mux stream's length prefix. */
function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/** Settles to the error, or `undefined` if `p` resolved. */
const failureOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("one mux per peer (experimental)", () => {
  it("carries every exchange with a peer over ONE stream, shared by concurrent first calls", async () => {
    const mounts = createMounts();
    mounts.provide("/open", async () => openBody());
    const { clientNode, serverNode, target } = await pair(route(mounts));
    const remote = createRemote({ node: clientNode, muxPerPeer: true });

    // Twenty calls before any mux exists: they must share one dial.
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => remote(target, new Request("http://peer.local/open"))),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(1);
    expect(streamsOn(clientNode, serverNode, PROTOCOL)).toBe(0);

    // And a later call reuses it.
    const another = await remote(target, new Request("http://peer.local/open"));
    expect(another.status).toBe(200);
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(1);
    for (const r of [...responses, another]) void r.body?.cancel().catch(() => {});
  }, 30_000);

  it("a dead peer fails every open exchange on the mux at once, then the next call reconnects", async () => {
    const mounts = createMounts();
    // Never answers: these calls wait for their head.
    mounts.provide("/hang", () => new Promise<Response>(() => {}));
    // Answers the head, then sends nothing: these calls wait in their body.
    mounts.provide("/open", async () => openBody());
    mounts.provide("/hello", async () => new Response("hello"));
    const { clientNode, serverNode, target } = await pair(route(mounts));
    const remote = createRemote({ node: clientNode, muxPerPeer: true });

    const beforeHead = Array.from({ length: 50 }, () =>
      failureOf(remote(target, new Request("http://peer.local/hang"))),
    );
    const bodies = await Promise.all(
      Array.from({ length: 50 }, () => remote(target, new Request("http://peer.local/open"))),
    );
    const inBody = bodies.map((r) => failureOf(r.text()));
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(1);

    // The peer dies abruptly: its connections are aborted, not closed.
    const killedAt = performance.now();
    for (const c of serverNode.getConnections()) c.abort(new Error("killed"));
    const failures = await Promise.all([...beforeHead, ...inBody]);
    const settledMs = performance.now() - killedAt;

    expect(failures).toHaveLength(100);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(PeerStreamResetError);
      expect(((failure as Error).cause as Error).name).toBe("PeerGoneError");
    }
    // The request timeout is 30 s: anything near it would be a hang, not a failure.
    expect(settledMs).toBeLessThan(2_000);

    // Reconnection is just the next call: a new connection and a new mux.
    const again = await remote(target, new Request("http://peer.local/hello"));
    expect(await again.text()).toBe("hello");
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(1);
  }, 30_000);

  it("a stalled reader holds only its own window, and another exchange still answers promptly", async () => {
    const CHUNK = 64 * 1024;
    const CAP = 32 * 1024 * 1024;
    let produced = 0;
    const flood: FetchHandler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // A cap, so the control below cannot exhaust memory.
            if (produced >= CAP) return new Promise(() => {});
            produced += CHUNK;
            controller.enqueue(new Uint8Array(CHUNK));
          },
        }),
      );
    const mounts = createMounts();
    mounts.provide("/flood", flood);
    mounts.provide("/ping", async () => new Response("pong"));

    const run = async (muxPerPeer: boolean) => {
      produced = 0;
      const { clientNode, target } = await pair(route(mounts));
      const remote = createRemote({ node: clientNode, muxPerPeer });
      // The head is in; the body is never read.
      const stalled = await remote(target, new Request("http://peer.local/flood"));
      expect(stalled.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const producedWhileStalled = produced;

      const pings: number[] = [];
      for (let i = 0; i < 20; i++) {
        const at = performance.now();
        const pong = await remote(target, new Request("http://peer.local/ping"));
        expect(await pong.text()).toBe("pong");
        pings.push(performance.now() - at);
      }
      await stalled.body?.cancel();
      return { producedWhileStalled, slowestPingMs: Math.max(...pings) };
    };

    const mux = await run(true);
    // The window, plus what the serving side holds between the body and the
    // port: a few chunks. Without the window this is the whole cap.
    expect(mux.producedWhileStalled).toBeLessThan(DEFAULT_MUX_WINDOW + 16 * CHUNK);
    expect(mux.slowestPingMs).toBeLessThan(500);

    // CONTROL: the same stall on one stream per exchange runs the producer to
    // the cap. Without it the bound above could be measuring a producer that
    // was never asked for more.
    const perExchange = await run(false);
    expect(perExchange.producedWhileStalled).toBeGreaterThan(8 * mux.producedWhileStalled);
  }, 60_000);

  it("falls back to a stream per exchange for a peer that does not speak the mux", async () => {
    const { clientNode, serverNode, target } = await pair(
      async () => new Response("old peer"),
      false,
    );
    const remote = createRemote({ node: clientNode, muxPerPeer: true });

    for (let i = 0; i < 3; i++) {
      const response = await remote(target, new Request("http://peer.local/x"));
      expect(await response.text()).toBe("old peer");
    }
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(0);
  }, 30_000);

  it("with fallback off, fails such a call with PeerProtocolUnsupportedError", async () => {
    const { clientNode, target } = await pair(async () => new Response("old peer"), false);
    const remote = createRemote({ node: clientNode, muxPerPeer: { fallback: false } });

    const failure = await failureOf(remote(target, new Request("http://peer.local/x")));
    expect(failure).toBeInstanceOf(PeerProtocolUnsupportedError);
  }, 30_000);

  it("a peer with the flag still serves callers without it", async () => {
    const { clientNode, serverNode, target } = await pair(async () => new Response("new peer"));
    const remote = createRemote({ node: clientNode, muxPerPeer: false });

    const response = await remote(target, new Request("http://peer.local/x"));
    expect(await response.text()).toBe("new peer");
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(0);
  }, 30_000);

  it("servePeer's stop() lets go of the muxes it opened and accepted", async () => {
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const clientNode = await node();
    const mounts = createMounts();
    mounts.provide("/hello", async () => new Response("hello"));
    const server = await servePeer({ node: serverNode, mounts, muxPerPeer: true });
    started.push(() => server.stop());
    const client = await servePeer({
      node: clientNode,
      mounts: createMounts(),
      muxPerPeer: true,
    });
    started.push(() => client.stop());
    await clientNode.dial(serverNode.getMultiaddrs()[0]);

    const response = await client.call(server.peerId, new Request("http://peer.local/hello"));
    expect(await response.text()).toBe("hello");
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(1);

    await client.stop();
    await expect
      .poll(() => streamsOn(clientNode, serverNode, MUX_PROTOCOL), { timeout: 5_000 })
      .toBe(0);
    await expect
      .poll(() => streamsOn(serverNode, clientNode, MUX_PROTOCOL), { timeout: 5_000 })
      .toBe(0);
  }, 30_000);
  it("the serving side caps exchanges per CONNECTION at maxInboundStreams, across its muxes", async () => {
    const mounts = createMounts();
    mounts.provide("/open", async () => openBody());
    const { clientNode, serverNode, target } = await pair(route(mounts), true, {
      maxInboundStreams: 4,
    });
    // Two links: two muxes on the one connection.
    const a = createRemote({ node: clientNode, muxPerPeer: true });
    const b = createRemote({ node: clientNode, muxPerPeer: true });
    const call = (remote: typeof a) =>
      remote(target, new Request("http://peer.local/open")).then(
        (response) => response,
        (error: unknown) => error,
      );

    const first = await Promise.all([call(a), call(a), call(a)]);
    const second = await Promise.all([call(b), call(b), call(b)]);
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(2);

    const all = [...first, ...second];
    const answered = all.filter((r) => r instanceof Response);
    const refused = all.filter((r) => !(r instanceof Response));
    expect(answered).toHaveLength(4);
    expect(refused).toHaveLength(2);
    for (const error of refused) expect(error).toBeInstanceOf(PeerStreamResetError);
    for (const r of answered) void (r as Response).body?.cancel().catch(() => {});
  }, 30_000);

  it("drops a served exchange whose write is blocked for drainTimeoutMs: an unread endless body's handler is cancelled, and its port freed", async () => {
    let cancelled = false;
    const mounts = createMounts();
    mounts.provide(
      "/flood",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    mounts.provide("/ok", async () => new Response("ok"));
    // One exchange at a time on the connection: the next call succeeds only
    // once the dropped exchange's port is no longer counted.
    const { clientNode, target } = await pair(route(mounts), true, {
      drainTimeoutMs: 500,
      maxInboundStreams: 1,
    });
    const remote = createRemote({ node: clientNode, muxPerPeer: true });

    const response = await remote(target, new Request("http://peer.local/flood"));
    expect(response.status).toBe(200);
    // Never read: the window fills, credit stops, and the write stays blocked.
    await expect.poll(() => cancelled, { timeout: 5_000 }).toBe(true);
    // The caller's body fails as a reset exchange does, not as a hang.
    const failure = await failureOf(response.arrayBuffer());
    expect(failure).toBeInstanceOf(PeerStreamResetError);
    // The port was released: under a cap of one, a new call is served.
    const next = await remote(target, new Request("http://peer.local/ok"));
    expect(await next.text()).toBe("ok");
  }, 30_000);

  it("aborts a mux stream whose peer announces a message past maxMessageBytes", async () => {
    const { clientNode, serverNode } = await pair(async () => new Response("ok"));
    const stream = await clientNode.dialProtocol(serverNode.peerId, MUX_PROTOCOL);
    // A varint length of 8 MiB (far past a frame plus headroom), then
    // a little of it: the receiver must refuse rather than buffer it.
    stream.send(Uint8Array.from([...varint(8 * 1024 * 1024), 1, 2, 3, 4]));
    await expect.poll(() => stream.status, { timeout: 5_000 }).not.toBe("open");
    expect(DEFAULT_MUX_FRAME_SIZE + MUX_MESSAGE_HEADROOM).toBeLessThan(8 * 1024 * 1024);
  }, 30_000);

  it("a peer on the old 16 KiB frame size and one on the default read each other, both directions", async () => {
    // A request body and a response body of 1 MiB each, in uneven blocks,
    // carried between frame sizes on either side: every message one side
    // sends must fit what the other accepts (`frameSize + MUX_MESSAGE_HEADROOM`).
    const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
    const SIZE = 1024 * 1024;
    const mounts = createMounts();
    mounts.provide("/echo", async (req) => {
      const body = new Uint8Array(await req.arrayBuffer());
      return new Response(body);
    });
    const blocks = (bytes: Uint8Array) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0, n = 1; at < bytes.byteLength; at += n, n = (n * 3 + 1) % 70_000) {
            controller.enqueue(bytes.slice(at, at + n));
          }
          controller.close();
        },
      });
    const OLD = { frameSize: 16 * 1024 };
    for (const [serving, calling] of [
      [OLD, true],
      [true, OLD],
    ] as const) {
      const { clientNode, serverNode, target } = await pair(route(mounts), serving);
      const remote = createRemote({ node: clientNode, muxPerPeer: calling });
      const sent = pattern(SIZE);
      const response = await remote(
        target,
        new Request("http://peer.local/echo", {
          method: "POST",
          body: blocks(sent),
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(200);
      const got = new Uint8Array(await response.arrayBuffer());
      expect(got.byteLength).toBe(SIZE);
      expect(got).toEqual(sent);
      // Over the mux, not a fallback.
      expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(1);
    }
  }, 30_000);

  it("a link that finds every mux stream on the connection taken uses a stream per exchange", async () => {
    const { clientNode, serverNode, target } = await pair(async () => new Response("hello"));
    const links = Array.from({ length: MUX_MAX_STREAMS_PER_CONNECTION + 1 }, () =>
      createRemote({ node: clientNode, muxPerPeer: true }),
    );
    for (const remote of links) {
      const response = await remote(target, new Request("http://peer.local/x"));
      expect(await response.text()).toBe("hello");
    }
    expect(streamsOn(clientNode, serverNode, MUX_PROTOCOL)).toBe(MUX_MAX_STREAMS_PER_CONNECTION);
  }, 30_000);
});
