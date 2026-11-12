/**
 * `connectionLiveness` (#56): a connection whose pings fail while it keeps
 * RECEIVING data is kept; a connection whose peer vanished silently (no FIN,
 * no RST) is still aborted, within a bounded time, idle or busy.
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
import type { Connection, Libp2p, Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AbortOnPingFailure,
  CONNECTION_LIVENESS_SERVICE,
  LIVENESS_PING_PROTOCOL,
} from "../src/connection-liveness.js";
import { generateKey } from "../src/identity.js";
import { createNode } from "../src/transport.js";

const INTERVAL_MS = 250;
const TIMEOUT_MS = 250;
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

async function node(abortOnPingFailure: AbortOnPingFailure, listen: string[] = []) {
  const created = await createNode({
    privateKey: await generateKey(),
    listen,
    transports: [tcp() as never],
    connectionMonitor: {
      pingIntervalMs: INTERVAL_MS,
      pingTimeout: { minTimeout: TIMEOUT_MS, maxTimeout: TIMEOUT_MS },
      abortOnPingFailure,
    },
  });
  cleanups.push(() => created.stop());
  return created;
}

/** Answer pings never; count how many arrive. */
async function stallPings(target: Libp2p): Promise<{ count: number }> {
  const seen = { count: 0 };
  const held: Stream[] = [];
  await target.handle(LIVENESS_PING_PROTOCOL, (stream) => {
    seen.count++;
    held.push(stream);
  });
  return seen;
}

/** Serve a small chunk every 20 ms for as long as the stream is open. */
async function serveTrickle(target: Libp2p): Promise<void> {
  await target.handle(TRICKLE, async (stream) => {
    const chunk = new Uint8Array(4096);
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

function closedAfter(connection: Connection, since: () => number): Promise<number> {
  return new Promise((resolve) =>
    connection.addEventListener("close", () => resolve(Date.now() - since()), { once: true }),
  );
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
    await sleep(8 * INTERVAL_MS);
    return { connection, got, serverSaw, clientSaw };
  }

  it("is kept while it receives data (default: when-silent)", async () => {
    const { connection, got, serverSaw, clientSaw } = await run("when-silent");
    // The scenario really happened: several pings each way went unanswered.
    expect(serverSaw.count).toBeGreaterThanOrEqual(4);
    expect(clientSaw.count).toBeGreaterThanOrEqual(4);
    expect(connection.status).toBe("open");
    const before = got.bytes;
    await sleep(200);
    expect(got.bytes).toBeGreaterThan(before);
  }, 20_000);

  it("is killed by libp2p's rule (always), which is the bug", async () => {
    const { connection } = await run("always");
    expect(connection.status).not.toBe("open");
  }, 20_000);
});

describe("connectionLiveness: a peer that vanishes silently", () => {
  async function connectThroughProxy(mode: AbortOnPingFailure) {
    const server = await node(mode, ["/ip4/127.0.0.1/tcp/0"]);
    const client = await node(mode);
    await serveTrickle(server);
    const serverPort = Number(server.getMultiaddrs()[0].toString().split("/")[4]);
    const proxy = await silentProxy(serverPort);
    const connection = await client.dial(
      multiaddr(`/ip4/127.0.0.1/tcp/${proxy.port}/p2p/${server.peerId}`),
    );
    // A few pings succeed first, so the timeout has a history.
    await sleep(3 * INTERVAL_MS);
    expect(connection.status).toBe("open");
    return { connection, proxy };
  }

  it("is detected on an idle connection within one interval plus the timeout", async () => {
    const { connection, proxy } = await connectThroughProxy("when-silent");
    let t0 = 0;
    const closed = closedAfter(connection, () => t0);
    t0 = Date.now();
    proxy.blackhole();
    const ms = await closed;
    expect(ms).toBeLessThanOrEqual(INTERVAL_MS + TIMEOUT_MS + 500);
  }, 20_000);

  it("is detected on a busy connection within two intervals plus the timeout", async () => {
    const { connection, proxy } = await connectThroughProxy("when-silent");
    const got = await readTrickle(connection);
    await sleep(2 * INTERVAL_MS);
    expect(got.bytes).toBeGreaterThan(0);
    let t0 = 0;
    const closed = closedAfter(connection, () => t0);
    t0 = Date.now();
    proxy.blackhole();
    const ms = await closed;
    expect(ms).toBeLessThanOrEqual(2 * INTERVAL_MS + TIMEOUT_MS + 500);
  }, 20_000);

  it("is never detected by this monitor with abortOnPingFailure: never", async () => {
    const { connection, proxy } = await connectThroughProxy("never");
    proxy.blackhole();
    await sleep(6 * INTERVAL_MS);
    expect(connection.status).toBe("open");
  }, 20_000);
});

describe("createNode's connection monitor", () => {
  it("installs connectionLiveness by default, and nothing with false", async () => {
    const withDefault = await createNode({ transports: [tcp() as never] });
    cleanups.push(() => withDefault.stop());
    expect(
      (withDefault.services as Record<string, unknown>)[CONNECTION_LIVENESS_SERVICE],
    ).toBeDefined();
    const without = await createNode({ transports: [tcp() as never], connectionMonitor: false });
    cleanups.push(() => without.stop());
    expect((without.services as Record<string, unknown>)[CONNECTION_LIVENESS_SERVICE]).toBe(
      undefined,
    );
  });
});
