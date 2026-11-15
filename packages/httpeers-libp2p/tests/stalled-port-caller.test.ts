/**
 * A CALLER ON THE PORT PROTOCOL CANNOT MAKE A SERVER BUFFER WITHOUT BOUND
 * (statewalker/webrun-wire#195). Every serving side, on either exchange path,
 * serves one stream per exchange through `webrun-streams-libp2p`'s `serve`,
 * which since 0.7 answers `/httpeers/1.0.0/ports/window`: each exchange a port
 * of its windowed native-port mux. In 0.7.0 the port's sender trusted the
 * window the caller announced (up to 4 GiB) and ignored the stream's
 * backpressure, with no stall bound, so a caller that announced a huge window
 * and paused its stream made a stock server buffer a whole download (1 GiB
 * past 40 s in the reproduction). From 0.7.1 the window is clamped to the
 * smaller of the two, data and credit wait while the stream needs a drain,
 * and `drainTimeoutMs` drops a writer stalled that long.
 *
 * The caller here is hostile on purpose: plain `connect` from
 * `webrun-streams-libp2p` with `window: 2 ** 32 - 1`, which reads the
 * response head of an endless download and then pauses its libp2p stream. The
 * server is an unchanged `serveTransport` (the default path, which serves the
 * port protocol too) with a short `drainTimeoutMs`. The duplex protocol rides
 * the same `serve`, so it is checked the same way.
 *
 * Two callers, because where the server's writer stops depends on the
 * caller's yamux:
 *
 *   - a stock node, whose yamux stream window (up to 16 MiB) takes the whole
 *     clamped port window (4 MiB) before backpressure reaches the server: the
 *     server then waits for port CREDIT. Checked for the bound only: 0.7.1's
 *     `drainTimeoutMs` counts a write blocked on the stream's drain, not one
 *     waiting for credit, so such an exchange stays parked (holding about a
 *     chunk on the server, the window sits with the caller) until the caller
 *     reads, cancels or its connection closes;
 *   - a node whose yamux grants at most 256 KiB per stream, so the server's
 *     stream fills and NEEDS A DRAIN first: checked for the bound and for the
 *     drop after `drainTimeoutMs`, which shows httpeers' `drainTimeoutMs`
 *     reaches `serveConnections` on the port path.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p, Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createRemoteOverLink } from "@statewalker/httpeers-bridge";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import { encodeMessage } from "@statewalker/webrun-http-streams";
import { connect } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { createDuplexMounts, DUPLEX_PROTOCOL, serveDuplex } from "../src/duplex.js";
import { generateKey } from "../src/identity.js";
import { createNode, PROTOCOL, serveTransport } from "../src/transport.js";

const DRAIN_TIMEOUT_MS = 2_000;
/** webrun-streams-libp2p's default port window, the server's own. */
const SERVER_WINDOW = 4 * 1024 * 1024;
const CHUNK = 256 * 1024;
/** Far past any bound, and small enough that a broken server does not exhaust the test runner. */
const PRODUCER_CAP = 256 * 1024 * 1024;
/** One window, the in-flight frames and the read-ahead of the response pipeline, with room. */
const BOUND = 3 * SERVER_WINDOW;
const HUGE_WINDOW = 2 ** 32 - 1;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length > 0) await Promise.resolve(cleanup.pop()?.()).catch(() => {});
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The caller's yamux: stock, or granting at most 256 KiB per stream so the server's writes block on drain. */
type CallerMuxer = "stock" | "small stream window";
const CALLERS: CallerMuxer[] = ["stock", "small stream window"];

async function nodes(caller: CallerMuxer) {
  const server = await createNode({
    privateKey: await generateKey(),
    listen: ["/ip4/127.0.0.1/tcp/0"],
    transports: [tcp() as never],
  });
  const client =
    caller === "stock"
      ? await createNode({ privateKey: await generateKey(), transports: [tcp() as never] })
      : await createLibp2p({
          transports: [tcp()],
          connectionEncrypters: [noise()],
          streamMuxers: [
            yamux({
              streamOptions: {
                initialStreamWindowSize: 256 * 1024,
                maxStreamWindowSize: 256 * 1024,
              },
            }),
          ],
        });
  cleanup.push(
    () => server.stop(),
    () => client.stop(),
  );
  await client.dial(server.getMultiaddrs()[0]);
  return { server, client };
}

/** An endless download that counts what it produced and notes when it is released. */
function download() {
  const state = { produced: 0, released: 0 };
  const body = () =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.produced >= PRODUCER_CAP) return controller.close();
        state.produced += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        state.released = performance.now();
      },
    });
  return { state, body };
}

function pauseCallerStreams(client: Libp2p, protocol: string): Stream[] {
  const paused: Stream[] = [];
  for (const c of client.getConnections())
    for (const s of c.streams)
      if (s.protocol === protocol) {
        s.pause();
        paused.push(s);
      }
  return paused;
}

function serverWriteBuffer(server: Libp2p): number {
  let bytes = 0;
  for (const c of server.getConnections())
    for (const s of c.streams)
      bytes += (s as { writeBufferLength?: number }).writeBufferLength ?? 0;
  return bytes;
}

/**
 * Watch the server after the caller paused: the largest write buffer and
 * production seen, and when (after the pause) the exchange was released.
 */
async function watch(server: Libp2p, state: { produced: number; released: number }) {
  const paused = performance.now();
  let maxBuffered = 0;
  const producedAtPause = state.produced;
  while (performance.now() - paused < DRAIN_TIMEOUT_MS * 3 && state.released === 0) {
    await sleep(100);
    maxBuffered = Math.max(maxBuffered, serverWriteBuffer(server));
  }
  // A little longer, to see that nothing more is produced once released.
  await sleep(500);
  return {
    maxBuffered,
    producedAfterPause: state.produced - producedAtPause,
    produced: state.produced,
    releasedAfterMs: state.released === 0 ? null : state.released - paused,
  };
}

/** The drop is checked where the server's write blocks on drain (see the file comment). */
function expectBoundedAndDropped(
  caller: CallerMuxer,
  seen: Awaited<ReturnType<typeof watch>>,
): void {
  expect(seen.produced).toBeLessThan(BOUND);
  expect(seen.maxBuffered).toBeLessThan(BOUND);
  if (caller === "stock") return;
  expect(seen.releasedAfterMs).not.toBeNull();
  expect(seen.releasedAfterMs).toBeGreaterThanOrEqual(DRAIN_TIMEOUT_MS * 0.5);
  expect(seen.releasedAfterMs).toBeLessThan(DRAIN_TIMEOUT_MS * 2.5);
}

describe.each(CALLERS)(
  "a caller announcing a huge port window, then pausing its stream (%s yamux)",
  (caller) => {
    it("fetch path: the server stays bounded by about one window", async () => {
      const { server, client } = await nodes(caller);
      const { state, body } = download();
      cleanup.push(
        await serveTransport({
          node: server,
          drainTimeoutMs: DRAIN_TIMEOUT_MS,
          dispatch: async () => new Response(body()),
        }),
      );
      const remote = createRemoteOverLink({
        requestTimeoutMs: 60_000,
        link: {
          async open() {
            const conn = await connect({
              node: client,
              peer: server.peerId,
              protocol: PROTOCOL,
              window: HUGE_WINDOW,
            });
            return { call: conn.call, close: conn.close };
          },
          // A caller only.
          serve: async () => async () => {},
        },
      });
      const response = await remote(
        server.peerId.toString() as PeerIdStr,
        new Request("http://peer.local/big"),
      );
      expect(response.status).toBe(200);
      expect(pauseCallerStreams(client, `${PROTOCOL}/ports/window`)).toHaveLength(1);

      const seen = await watch(server, state);
      console.log(`fetch path, stalled port caller (${caller} yamux):`, JSON.stringify(seen));
      expectBoundedAndDropped(caller, seen);
    }, 30_000);

    it("duplex protocol: the same", async () => {
      const { server, client } = await nodes(caller);
      const state = { produced: 0, released: 0 };
      const mounts = createDuplexMounts();
      mounts.provide("/big", async function* () {
        try {
          while (state.produced < PRODUCER_CAP) {
            state.produced += CHUNK;
            yield new Uint8Array(CHUNK);
          }
        } finally {
          state.released = performance.now();
        }
      });
      cleanup.push(await serveDuplex({ node: server, mounts, drainTimeoutMs: DRAIN_TIMEOUT_MS }));
      const conn = await connect({
        node: client,
        peer: server.peerId,
        protocol: DUPLEX_PROTOCOL,
        window: HUGE_WINDOW,
      });
      cleanup.push(() => conn.close());
      const output = conn.call(encodeMessage({ path: "/big" }, (async function* () {})()));
      expect((await output.next()).done).toBe(false);
      expect(pauseCallerStreams(client, `${DUPLEX_PROTOCOL}/ports/window`)).toHaveLength(1);

      const seen = await watch(server, state);
      console.log(`duplex protocol, stalled port caller (${caller} yamux):`, JSON.stringify(seen));
      expectBoundedAndDropped(caller, seen);
    }, 30_000);
  },
);
