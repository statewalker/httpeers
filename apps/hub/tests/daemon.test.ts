/**
 * The daemon, end to end, against an in-process relay.
 *
 * NOTHING HERE TOUCHES THE PUBLIC INTERNET. The relay is `startRelay` on a
 * loopback port, and the relay document the daemon fetches is served from a
 * local HTTP server pointing at it -- the same shape as
 * `https://relay.httpeers.net/.well-known/httpeers-relay.json`, one hop closer.
 *
 * THE TWO WAYS IN, and why both are asserted. The mesh reaches a module
 * through `withAccess` (a member's token, the transport-proven peer); the
 * local door reaches the SAME handler with no access layer at all. Each call
 * reports which way it came, so a door that accidentally went through the mesh
 * mounts -- or a mount that skipped access -- shows up as the wrong `caller`.
 */

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createMounts } from "@statewalker/httpeers-core";
import { type MemberHandle, startMember } from "@statewalker/httpeers-member";
import { type Relay, startRelay } from "@statewalker/httpeers-relay";
import { createLibp2p } from "libp2p";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HubConfig } from "../src/config.js";
import { type Daemon, startDaemon } from "../src/daemon.js";
import type { ServiceModule } from "../src/service-module.js";

/** A module that says what it was asked and who asked. */
const echo: ServiceModule = {
  id: "echo",
  advertisement: { id: "echo", kind: "test-service", title: "Echo" },
  rules: ['capability("app:echo.use") <- role("member");'],
  policies: [
    'allow if capability("app:echo.use"), resource("/echo")' +
      ' or capability("app:echo.use"), resource($r), $r.starts_with("/echo/");',
  ],
  handler: async (request, context) =>
    Response.json({ path: new URL(request.url).pathname, caller: context.caller }),
};

let relay: Relay;
let relayDoc: Server;
let relayDocUrl: string;
const dirs: string[] = [];
const daemons: Daemon[] = [];
const members: MemberHandle[] = [];

beforeAll(async () => {
  relay = await startRelay({ privateKey: await generateKeyPair("Ed25519"), port: 0 });
  const relayAddrs = relay.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .filter((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  expect(relayAddrs.length).toBeGreaterThan(0);

  relayDoc = createServer((req, res) => {
    if (req.url !== "/.well-known/httpeers-relay.json") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ relayAddrs }));
  });
  relayDoc.listen(0, "127.0.0.1");
  await once(relayDoc, "listening");
  const { port } = relayDoc.address() as AddressInfo;
  relayDocUrl = `http://127.0.0.1:${port}/.well-known/httpeers-relay.json`;
});

afterEach(async () => {
  while (members.length > 0)
    await members
      .pop()
      ?.stop()
      .catch(() => {});
  while (daemons.length > 0)
    await daemons
      .pop()
      ?.stop()
      .catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
}, 30_000);

afterAll(async () => {
  relayDoc?.close();
  await relay?.stop();
});

async function configFor(dataDir?: string): Promise<HubConfig> {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "hub-daemon-")));
  if (dataDir == null) dirs.push(dir);
  return {
    dataDir: dir,
    relayDoc: relayDocUrl,
    services: ["echo"],
    joinPageUrl: "https://example.test/mesh.html",
    // Port 0: the suite must not depend on 8787 being free.
    localDoorPort: 0,
  };
}

async function start(config: HubConfig): Promise<Daemon> {
  const daemon = await startDaemon(config, [echo]);
  daemons.push(daemon);
  return daemon;
}

/** A page's node: webSockets + webRTC + circuitRelay, listening on `/webrtc` only. */
async function webRTCNode({ privateKey }: { privateKey?: Ed25519PrivateKey }) {
  return createLibp2p({
    ...(privateKey != null ? { privateKey } : {}),
    addresses: { listen: ["/webrtc"] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

/** A node that can reach the hub ONLY through the relay: what a member of a bridged hub falls back to. */
async function relayOnlyNode({ privateKey }: { privateKey?: Ed25519PrivateKey }) {
  return createLibp2p({
    ...(privateKey != null ? { privateKey } : {}),
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

async function joinMember(
  daemon: Daemon,
  createNode: (init: { privateKey?: Ed25519PrivateKey }) => ReturnType<typeof webRTCNode>,
): Promise<MemberHandle> {
  const { id } = await daemon.hub.invitations.create(["member"], 60_000);
  const member = await startMember({
    key: "peers",
    mounts: createMounts(),
    rules: daemon.hub.rules,
    config: { relayAddrs: daemon.relayAddrs, hubPeerId: daemon.hubPeerId },
    platform: { createNode: ({ privateKey }) => createNode({ privateKey }) },
    invitationId: id,
  });
  members.push(member);
  return member;
}

describe("startDaemon", () => {
  it("says READY once with its peerId, and keeps that peerId across a restart", async () => {
    const log = vi.spyOn(console, "log");
    const config = await configFor();

    const first = await start(config);
    expect(first.hubPeerId).toMatch(/^12D3Koo/);
    const ready = log.mock.calls.map((args) => args.join(" ")).filter((l) => l.startsWith("READY"));
    expect(ready).toEqual([`READY ${first.hubPeerId}`]);

    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await start(config);
    expect(second.hubPeerId).toBe(first.hubPeerId);
  }, 90_000);

  it("serves a module on the local door with caller local, and 404s everything else", async () => {
    const daemon = await start(await configFor());
    const door = `http://127.0.0.1:${daemon.localDoorPort}`;

    const res = await fetch(`${door}/peers/${daemon.hubPeerId}/echo/x`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/echo/x", caller: "local" });

    expect((await fetch(`${door}/peers/${daemon.hubPeerId}/nope/x`)).status).toBe(404);
    expect((await fetch(`${door}/peers/12D3KooWSomeoneElse/echo/x`)).status).toBe(404);
    expect((await fetch(`${door}/elsewhere`)).status).toBe(404);
    // Not the mesh mounts: the hub's own endpoints are not reachable through the door.
    expect((await fetch(`${door}/peers/${daemon.hubPeerId}/.well-known/mesh`)).status).toBe(404);
  }, 90_000);

  it("serves a module to a member that joined with an invitation, with caller mesh", async () => {
    const daemon = await start(await configFor());
    const member = await joinMember(daemon, webRTCNode);
    expect(member.joinedBy).toBe("redeemed");

    const res = await member.fetch(new Request(`http://local/peers/${daemon.hubPeerId}/echo/x`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/echo/x", caller: "mesh" });

    // The advertisement is in the mesh view the member sees.
    expect(
      daemon.hub
        .meshView()
        .advertisements.some((a) => a.id === "echo" && a.kind === "test-service"),
    ).toBe(true);
  }, 90_000);

  it("serves a member that can reach it only over the relay", async () => {
    const daemon = await start(await configFor());
    const member = await joinMember(daemon, relayOnlyNode);
    expect(member.hubLink()).toBe("relay");

    const res = await member.fetch(new Request(`http://local/peers/${daemon.hubPeerId}/echo/x`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/echo/x", caller: "mesh" });
  }, 90_000);

  it("remembers members and revocations across a restart", async () => {
    const config = await configFor();
    const first = await start(config);
    const member = await joinMember(first, webRTCNode);
    expect(first.hub.isMember(member.peerId)).toBe(true);
    first.hub.revocations.changeRoles(member.peerId, ["member"]);

    await member.stop();
    members.splice(members.indexOf(member), 1);
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await start(config);
    expect(second.hub.isMember(member.peerId)).toBe(true);
    expect(second.hub.revocations.list().map((e) => e.peerId)).toEqual([member.peerId]);
  }, 90_000);
});
