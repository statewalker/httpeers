/**
 * Many nodes on one host dial the relay at once (statewalker/httpeers#164).
 *
 * libp2p refuses inbound connections past `inboundConnectionThreshold` per
 * host per second (default 5) and past `maxIncomingPendingConnections` still
 * upgrading (default 10). A runtime that starts one node per mesh (an extension
 * with several hubs and memberships) dialled 8 at once and lost 3 with
 * `EncryptionFailedError: Unexpected EOF`. Behind the reverse proxy every
 * client arrives from the proxy's one address, so the per-host figure is the
 * relay's whole budget for new connections. `limits.ts` sets both; this checks
 * that as many nodes as the limit allows, dialling at once from one host, all
 * get through.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { generateRelayKey } from "../src/key.js";
import { INBOUND_CONNECTION_THRESHOLD } from "../src/limits.js";
import { type Relay, startRelay } from "../src/relay.js";

let dir: string | undefined;
let relay: Relay | undefined;
const clients: Libp2p[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => Promise.resolve(c.stop()).catch(() => {})));
  await relay?.stop();
  relay = undefined;
  if (dir != null) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("simultaneous dials from one host", () => {
  it(`admits ${INBOUND_CONNECTION_THRESHOLD} nodes dialling at once`, async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-relay-"));
    relay = await startRelay({
      privateKey: await generateRelayKey(join(dir, "relay.key")),
      port: 0,
    });
    const addr = relay.node
      .getMultiaddrs()
      .map(String)
      .find((a) => a.includes("/ip4/"));
    expect(addr).toBeDefined();
    const target = multiaddr((addr as string).replace("/ip4/0.0.0.0/", "/ip4/127.0.0.1/"));

    for (let i = 0; i < INBOUND_CONNECTION_THRESHOLD; i++) {
      clients.push(
        await createLibp2p({
          transports: [webSockets()],
          connectionEncrypters: [noise()],
          streamMuxers: [yamux()],
          services: { identify: identify() },
        }),
      );
    }

    const results = await Promise.allSettled(clients.map((c) => c.dial(target)));
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
  }, 60_000);
});
