/**
 * `connectionLiveness` (#56): a connection whose pings fail while it keeps
 * RECEIVING data is kept; a connection whose peer vanished silently (no FIN,
 * no RST) is still aborted, within a bounded time, idle or busy, and however
 * slow another connection's pings are.
 *
 * Pings are made to fail deterministically by registering a ping handler that
 * never answers, which is what a ping stuck behind seconds of queued bulk
 * data looks like from the pinging side. A silent death is a TCP proxy that
 * stops forwarding in both directions without closing either socket.
 *
 * Short intervals and timeouts keep the tests fast; the bounds asserted are
 * in units of them.
 */

import net from "node:net";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import type { Connection, Libp2p, Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { byteStream } from "@libp2p/utils";
import { webRTC } from "@libp2p/webrtc";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AbortOnPingFailure,
  CONNECTION_LIVENESS_SERVICE,
  type ConnectionLiveness,
  type ConnectionLivenessOptions,
  connectionLiveness,
  LIVENESS_PING_PROTOCOL,
  STATS_SAMPLE_TIMEOUT_MS,
  statsBytesReceived,
} from "../src/connection-liveness.js";
import { generateKey } from "../src/identity.js";
import { dialRelay, waitForCircuitReservation } from "../src/reservation.js";
import { createNode, type TransportFactory } from "../src/transport.js";

const INTERVAL_MS = 200;
/** The floor of every ping timeout here; answered loopback pings keep it there. */
const TIMEOUT_MS = 200;
/** Scheduling slack on a loaded CI machine. */
const SLACK_MS = 500;
const TRICKLE = "/test/trickle/1.0.0";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()?.();
    } catch {
      // already gone
    }
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function node(
  abortOnPingFailure: AbortOnPingFailure,
  listen: string[] = [],
  transports: TransportFactory[] = [tcp() as never],
  services: Record<string, unknown> = {},
  timeoutMultiplier?: number,
) {
  const options: ConnectionLivenessOptions = {
    pingIntervalMs: INTERVAL_MS,
    // A ceiling well above the floor, so a timeout that grew would show; the
    // moving average's time span scaled with the interval, as 5 s is to 10 s.
    pingTimeout: {
      minTimeout: TIMEOUT_MS,
      maxTimeout: 4_000,
      interval: INTERVAL_MS / 2,
      ...(timeoutMultiplier != null ? { timeoutMultiplier } : {}),
    },
    abortOnPingFailure,
  };
  const created = await createNode({
    privateKey: await generateKey(),
    listen,
    transports,
    services,
    connectionMonitor: options,
  });
  cleanups.push(() => created.stop());
  return created;
}

function liveness(of: Libp2p): ConnectionLiveness {
  return (of.services as Record<string, ConnectionLiveness>)[CONNECTION_LIVENESS_SERVICE];
}

/** Answer pings never; count how many arrive. */
async function stallPings(target: Libp2p): Promise<{ count: number }> {
  const seen = { count: 0 };
  const held: Stream[] = [];
  await target.handle(
    LIVENESS_PING_PROTOCOL,
    (stream) => {
      seen.count++;
      held.push(stream);
    },
    { runOnLimitedConnection: true },
  );
  return seen;
}

/** Serve 16 KiB every 20 ms (~800 KB/s) for as long as the stream is open. */
async function serveTrickle(target: Libp2p): Promise<void> {
  await target.handle(TRICKLE, async (stream) => {
    const chunk = new Uint8Array(16 * 1024);
    while (stream.status === "open") {
      if (!stream.send(chunk)) await stream.onDrain().catch(() => {});
      await sleep(20);
    }
  });
}

/** Read a trickle on `connection`; returns the running byte count. */
async function readTrickle(connection: Connection): Promise<{ bytes: number }> {
  const got = { bytes: 0 };
  const stream = await connection.newStream(TRICKLE);
  void (async () => {
    try {
      for await (const chunk of stream) got.bytes += chunk.byteLength;
    } catch {
      // the connection died; the test says so
    }
  })();
  return got;
}

/** A TCP proxy that can go silent: stop forwarding, close nothing. */
async function silentProxy(targetPort: number) {
  let holed = false;
  const sockets: net.Socket[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      from.on("data", (data) => {
        if (!holed) to.write(data);
      });
      from.on("error", () => {});
    }
    sockets.push(client, upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    blackhole: () => {
      holed = true;
    },
  };
}

function portOf(target: Libp2p): number {
  return Number(target.getMultiaddrs()[0].toString().split("/")[4]);
}

async function dialThroughProxy(from: Libp2p, to: Libp2p) {
  const proxy = await silentProxy(portOf(to));
  const connection = await from.dial(
    multiaddr(`/ip4/127.0.0.1/tcp/${proxy.port}/p2p/${to.peerId}`),
  );
  return { connection, proxy };
}

/** Blackhole the proxy now; resolves with how long the connection took to close. */
function blackholeAndTime(
  connection: Connection,
  proxy: { blackhole: () => void },
): Promise<number> {
  const t0 = Date.now();
  const closed = new Promise<number>((resolve) =>
    connection.addEventListener("close", () => resolve(Date.now() - t0), { once: true }),
  );
  proxy.blackhole();
  return closed;
}

describe("connectionLiveness: a busy connection whose pings fail", () => {
  async function run(mode: AbortOnPingFailure) {
    const server = await node(mode, ["/ip4/127.0.0.1/tcp/0"]);
    const client = await node(mode);
    // Both directions' pings fail: each side stalls the other's.
    const serverSaw = await stallPings(server);
    const clientSaw = await stallPings(client);
    await serveTrickle(server);
    const connection = await client.dial(server.getMultiaddrs()[0]);
    const got = await readTrickle(connection);
    await sleep(6 * INTERVAL_MS);
    return { client, connection, got, serverSaw, clientSaw };
  }

  it("is kept while it receives data, and its timeout does not grow (default: when-silent)", async () => {
    const { client, connection, got, serverSaw, clientSaw } = await run("when-silent");
    // The scenario really happened: several pings each way went unanswered.
    expect(serverSaw.count).toBeGreaterThanOrEqual(3);
    expect(clientSaw.count).toBeGreaterThanOrEqual(3);
    expect(connection.status).toBe("open");
    // Unanswered pings are not round-trip samples: the timeout stays at its floor.
    expect(liveness(client).nextTimeoutMs(connection)).toBe(TIMEOUT_MS);
    const before = got.bytes;
    await sleep(100);
    expect(got.bytes).toBeGreaterThan(before);
  }, 15_000);

  it("is killed by libp2p's rule (always), which is the bug", async () => {
    const { connection } = await run("always");
    expect(connection.status).not.toBe("open");
  }, 15_000);
});

describe("connectionLiveness: a peer that vanishes silently", () => {
  it("is detected on an idle connection of a quiet node within one interval plus the timeout", async () => {
    const server = await node("when-silent", ["/ip4/127.0.0.1/tcp/0"]);
    const client = await node("when-silent");
    const { connection, proxy } = await dialThroughProxy(client, server);
    await sleep(2 * INTERVAL_MS); // a few answered pings first
    expect(connection.status).toBe("open");
    expect(liveness(client).byteSource(connection)).toBe("transport-events");
    const ms = await blackholeAndTime(connection, proxy);
    expect(ms).toBeLessThanOrEqual(INTERVAL_MS + TIMEOUT_MS + SLACK_MS);
  }, 15_000);

  it("is detected on a busy connection within two intervals plus the timeout", async () => {
    const server = await node("when-silent", ["/ip4/127.0.0.1/tcp/0"]);
    const client = await node("when-silent");
    await serveTrickle(server);
    const { connection, proxy } = await dialThroughProxy(client, server);
    const got = await readTrickle(connection);
    await sleep(2 * INTERVAL_MS);
    expect(got.bytes).toBeGreaterThan(0);
    const ms = await blackholeAndTime(connection, proxy);
    expect(ms).toBeLessThanOrEqual(2 * INTERVAL_MS + TIMEOUT_MS + SLACK_MS);
  }, 15_000);

  it("is detected within two intervals plus ITS OWN timeout while other connections' pings fail", async () => {
    // One node, four peers. To each `busy` peer, pings are never answered
    // while a trickle keeps arriving: kept, failing every tick. To `quiet`,
    // pings are answered, then the peer goes silent. A timeout estimator
    // shared between them would have grown on the busy failures and delayed
    // `quiet`'s detection; and the node receiving from `busy` reads as a
    // congested link, so `quiet` gets its second silent failure, not its first.
    const client = await node("when-silent");
    const busyConnections: Connection[] = [];
    for (let i = 0; i < 3; i++) {
      const busy = await node("when-silent", ["/ip4/127.0.0.1/tcp/0"]);
      await stallPings(busy);
      await serveTrickle(busy);
      const connection = await client.dial(busy.getMultiaddrs()[0]);
      await readTrickle(connection);
      busyConnections.push(connection);
    }
    const quiet = await node("when-silent", ["/ip4/127.0.0.1/tcp/0"]);
    const { connection: quietConnection, proxy } = await dialThroughProxy(client, quiet);
    await sleep(6 * INTERVAL_MS);
    for (const connection of busyConnections) expect(connection.status).toBe("open");
    expect(liveness(client).nextTimeoutMs(quietConnection)).toBe(TIMEOUT_MS);

    const ms = await blackholeAndTime(quietConnection, proxy);
    expect(ms).toBeLessThanOrEqual(2 * INTERVAL_MS + TIMEOUT_MS + SLACK_MS);
    for (const connection of busyConnections) expect(connection.status).toBe("open");
  }, 15_000);

  it("one connection's slow answered pings do not lengthen another connection's timeout", async () => {
    // Timeouts of 3 x the average answered ping: `slow` answers after 150 ms
    // (timeout ~450 ms), `fast` at once (timeout at its 200 ms floor). With one
    // estimator for both, `fast` would read ~450 ms after each `slow` answer.
    const client = await node("when-silent", [], [tcp() as never], {}, 3);
    const slow = await node("when-silent", ["/ip4/127.0.0.1/tcp/0"]);
    const fast = await node("when-silent", ["/ip4/127.0.0.1/tcp/0"]);
    await slow.handle(LIVENESS_PING_PROTOCOL, async (stream) => {
      const bytes = byteStream(stream);
      const ping = await bytes.read({ bytes: 32 });
      await sleep(150);
      await bytes.write(ping);
    });
    const slowConnection = await client.dial(slow.getMultiaddrs()[0]);
    const fastConnection = await client.dial(fast.getMultiaddrs()[0]);
    const fastSeen = new Set<number>();
    let slowMax = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(50);
      fastSeen.add(liveness(client).nextTimeoutMs(fastConnection) ?? -1);
      slowMax = Math.max(slowMax, liveness(client).nextTimeoutMs(slowConnection) ?? 0);
    }
    expect(slowMax).toBeGreaterThanOrEqual(400);
    expect([...fastSeen]).toEqual([TIMEOUT_MS]);
  }, 15_000);

  it("is never detected by this monitor with abortOnPingFailure: never", async () => {
    const server = await node("never", ["/ip4/127.0.0.1/tcp/0"]);
    const client = await node("never");
    const { connection, proxy } = await dialThroughProxy(client, server);
    await sleep(INTERVAL_MS);
    proxy.blackhole();
    await sleep(4 * INTERVAL_MS);
    expect(connection.status).toBe("open");
  }, 15_000);
});

describe("connectionLiveness over WebRTC", () => {
  it("reads received bytes from getStats, and keeps a busy connection whose pings fail", async () => {
    const webrtc = () => [
      tcp() as never,
      circuitRelayTransport() as never,
      webRTC({ rtcConfiguration: { iceServers: [] } }) as never,
    ];
    const relay = await node("when-silent", ["/ip4/127.0.0.1/tcp/0"], [tcp() as never], {
      relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }),
    });
    const server = await node("when-silent", ["/p2p-circuit", "/webrtc"], webrtc());
    const client = await node("when-silent", [], webrtc());
    await dialRelay(server, relay.getMultiaddrs()[0].toString());
    await waitForCircuitReservation(server);
    const serverSaw = await stallPings(server);
    await serveTrickle(server);
    const connection = await client.dial(
      multiaddr(`${relay.getMultiaddrs()[0]}/p2p-circuit/webrtc/p2p/${server.peerId}`),
    );
    expect(connection.remoteAddr.toString()).toContain("/webrtc");
    expect(liveness(client).byteSource(connection)).toBe("webrtc-stats");
    await readTrickle(connection);
    await sleep(6 * INTERVAL_MS);
    expect(serverSaw.count).toBeGreaterThanOrEqual(3);
    expect(connection.status).toBe("open");
    // Progress was seen through the stats, at a failed ping's end.
    expect(liveness(client).lastReceivedAt(connection)).toBeGreaterThan(
      Date.now() - 3 * INTERVAL_MS,
    );
  }, 30_000);

  it("still aborts a silent connection whose getStats() never settles, within the bound", async () => {
    // Fake components and a fake WebRTC connection: getStats hangs forever,
    // and every ping times out (the peer is gone). A sample awaited without
    // a bound would park the check for good.
    const aborted: { at?: number } = {};
    const fake = {
      id: "fake",
      status: "open",
      remotePeer: { toString: () => "peer" },
      maConn: { peerConnection: { getStats: () => new Promise(() => {}) } },
      newStream: (_protocol: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
      abort: () => {
        aborted.at = Date.now();
        fake.status = "aborted";
      },
    };
    const log = Object.assign(() => {}, { error: () => {}, trace: () => {} });
    const events = new EventTarget();
    const monitor = connectionLiveness({
      pingIntervalMs: INTERVAL_MS,
      pingTimeout: { minTimeout: TIMEOUT_MS, maxTimeout: TIMEOUT_MS },
    })({
      connectionManager: { getConnections: () => [fake as unknown as Connection] },
      events: events as never,
      logger: { forComponent: () => log } as never,
    });
    monitor.start();
    cleanups.push(() => monitor.stop());
    const t0 = Date.now();
    events.dispatchEvent(new CustomEvent("connection:open", { detail: fake }));
    expect(monitor.byteSource(fake as unknown as Connection)).toBe("webrtc-stats");
    const sampleBound = Math.min(STATS_SAMPLE_TIMEOUT_MS, INTERVAL_MS / 4);
    while (aborted.at === undefined && Date.now() - t0 < 5_000) await sleep(20);
    // The first tick pings; one bounded sample before it, one after it fails.
    expect(aborted.at).toBeDefined();
    expect((aborted.at ?? Infinity) - t0).toBeLessThanOrEqual(
      INTERVAL_MS + 2 * sampleBound + TIMEOUT_MS + SLACK_MS,
    );
  });

  it("sums transport stats when present, else the candidate pairs", async () => {
    const report = (stats: Array<Record<string, unknown>>) => ({
      getStats: async () => new Map(stats.map((s, i) => [String(i), s])),
    });
    expect(
      await statsBytesReceived(
        report([
          { type: "transport", bytesReceived: 10 },
          { type: "candidate-pair", bytesReceived: 99 },
        ]),
      ),
    ).toBe(10);
    expect(
      await statsBytesReceived(
        report([
          { type: "candidate-pair", bytesReceived: 5 },
          { type: "candidate-pair", bytesReceived: 7 },
        ]),
      ),
    ).toBe(12);
    expect(await statsBytesReceived(report([{ type: "local-candidate" }]))).toBe(undefined);
  });
});

describe("createNode's connection monitor", () => {
  const componentsOf = (of: Libp2p) =>
    (of as unknown as { components: { components: Record<string, unknown> } }).components
      .components;

  it("installs connectionLiveness and disables libp2p's own monitor by default", async () => {
    const withDefault = await createNode({ transports: [tcp() as never] });
    cleanups.push(() => withDefault.stop());
    expect(liveness(withDefault)).toBeDefined();
    expect(componentsOf(withDefault).connectionMonitor).toBe(undefined);
    // The control: a node built with libp2p's defaults does run its monitor.
    const plain = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
    });
    cleanups.push(() => plain.stop());
    expect(componentsOf(plain).connectionMonitor).toBeDefined();
  });

  it("runs no monitor at all with false", async () => {
    const without = await createNode({ transports: [tcp() as never], connectionMonitor: false });
    cleanups.push(() => without.stop());
    expect(liveness(without)).toBe(undefined);
    expect(componentsOf(without).connectionMonitor).toBe(undefined);
  });
});
