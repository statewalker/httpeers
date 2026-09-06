/**
 * Integration: a real relay, dialled by a real peer, over a real port.
 *
 * The assertion that matters is the announce one. A relay that starts and
 * reports healthy while advertising a container-internal address is the
 * deployment's worst failure mode, and it is invisible to every other check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicAnnounceAddr } from "../src/addresses.js";
import { generateRelayKey } from "../src/key.js";
import { type Relay, startRelay } from "../src/relay.js";

const PORT = 19_090;

let dir: string;
let relay: Relay | undefined;
let client: Libp2p | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-relay-"));
});

afterEach(async () => {
  await client?.stop();
  await relay?.stop();
  client = undefined;
  relay = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(announce?: string[]): Promise<Relay> {
  const privateKey = await generateRelayKey(join(dir, "relay.key"));
  relay = await startRelay({ privateKey, port: PORT, announce });
  return relay;
}

describe("startRelay", () => {
  it("listens on the port it was given, in plain ws", async () => {
    const r = await start();
    const addrs = r.node.getMultiaddrs().map(String);
    expect(addrs.some((a) => a.includes(`/tcp/${PORT}/ws`))).toBe(true);
  });

  it("keeps the identity it was given rather than generating one", async () => {
    const privateKey = await generateRelayKey(join(dir, "relay.key"));
    relay = await startRelay({ privateKey, port: PORT });
    const { peerIdFromPrivateKey } = await import("@libp2p/peer-id");
    expect(relay.node.peerId.toString()).toBe(peerIdFromPrivateKey(privateKey).toString());
  });

  describe("announce addresses", () => {
    it("advertises the public address when one is configured", async () => {
      const announced = publicAnnounceAddr("relay.httpeers.net");
      const r = await start([announced]);
      const addrs = r.node.getMultiaddrs().map(String);
      expect(addrs.some((a) => a.startsWith(announced))).toBe(true);
    });

    // The whole point: with announce set, the unreachable bound address must
    // NOT also be advertised, or peers will try it and fail.
    it("does not also advertise the container-internal address", async () => {
      const r = await start([publicAnnounceAddr("relay.httpeers.net")]);
      const addrs = r.node.getMultiaddrs().map(String);
      expect(addrs.some((a) => a.includes("/ip4/0.0.0.0/"))).toBe(false);
      expect(addrs.some((a) => a.includes(`/tcp/${PORT}/ws`))).toBe(false);
    });

    it("appends the peer id itself, which is why announce must not carry one", async () => {
      const r = await start([publicAnnounceAddr("relay.httpeers.net")]);
      const advertised = r.node.getMultiaddrs().map(String);
      const withPeerId = advertised.filter((a) => a.includes("/p2p/"));
      expect(withPeerId.length).toBeGreaterThan(0);
      for (const a of withPeerId) {
        expect(a.split("/p2p/").length - 1).toBe(1);
        expect(a.endsWith(`/p2p/${r.node.peerId.toString()}`)).toBe(true);
      }
    });

    it("rejects an announce address carrying /p2p/ before starting", async () => {
      const privateKey = await generateRelayKey(join(dir, "relay.key"));
      await expect(
        startRelay({
          privateKey,
          port: PORT,
          announce: ["/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3KooWaBcDeF"],
        }),
      ).rejects.toThrow(/must not contain a \/p2p\/ component/);
    });
  });

  it("grants a circuit reservation to a peer that dials it", async () => {
    const r = await start();
    const relayAddr = r.node
      .getMultiaddrs()
      .map(String)
      .find((a) => a.includes("127.0.0.1") || a.includes("/ip4/"));
    expect(relayAddr).toBeDefined();

    client = await createLibp2p({
      addresses: { listen: ["/p2p-circuit"] },
      transports: [webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });

    const dialTarget = (relayAddr as string).replace("/ip4/0.0.0.0/", "/ip4/127.0.0.1/");
    await client.dial(multiaddr(dialTarget));

    // The reservation lands asynchronously after the dial resolves -- poll for
    // it rather than treating dial resolution as readiness.
    let circuit: string | undefined;
    for (let i = 0; i < 40; i++) {
      circuit = client
        .getMultiaddrs()
        .map(String)
        .find((a) => a.includes("p2p-circuit"));
      if (circuit != null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(circuit).toBeDefined();
  });
});
