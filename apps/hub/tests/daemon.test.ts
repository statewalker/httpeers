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
import { decodeJoinBlob, type MemberHandle, startMember } from "@statewalker/httpeers-member";
import { type Relay, startRelay } from "@statewalker/httpeers-relay";
import { createLibp2p } from "libp2p";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HubConfig } from "../src/config.js";
import { type Daemon, startDaemon } from "../src/daemon.js";
import type { ServiceModule } from "../src/service-module.js";
import { doorFetch, doorSettings, freePort } from "./door.js";

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
  // maxRetries: CI failed once with ENOTEMPTY on `<dir>/hub/state` -- a state write landing
  // while the directory was being removed, after stop() had resolved. A retry makes the cleanup
  // robust; a write after stop() is a separate question, recorded in the PR, not hidden here
  // (every assertion ran before this point).
  while (dirs.length > 0)
    await rm(dirs.pop() as string, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
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
    // A free port, not 8787: the suite must not depend on it being free. Not
    // 0 either: the door's allowed Host has to name the port before it binds.
    ...doorSettings(await freePort()),
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

async function joinWithInvitation(
  daemon: Daemon,
  invitationId: string,
  relayAddrs: string[] = daemon.relayAddrs,
  createNode: (init: {
    privateKey?: Ed25519PrivateKey;
  }) => ReturnType<typeof webRTCNode> = webRTCNode,
): Promise<MemberHandle> {
  const member = await startMember({
    key: "peers",
    mounts: createMounts(),
    rules: daemon.hub.rules,
    config: { relayAddrs, hubPeerId: daemon.hubPeerId },
    platform: { createNode: ({ privateKey }) => createNode({ privateKey }) },
    invitationId,
  });
  members.push(member);
  return member;
}

async function joinMember(
  daemon: Daemon,
  createNode: (init: { privateKey?: Ed25519PrivateKey }) => ReturnType<typeof webRTCNode>,
  keepaliveIntervalMs?: number,
): Promise<MemberHandle> {
  const { id } = await daemon.hub.invitations.create(["member"], 60_000);
  const member = await startMember({
    key: "peers",
    mounts: createMounts(),
    rules: daemon.hub.rules,
    config: { relayAddrs: daemon.relayAddrs, hubPeerId: daemon.hubPeerId },
    platform: { createNode: ({ privateKey }) => createNode({ privateKey }) },
    invitationId: id,
    ...(keepaliveIntervalMs != null ? { keepaliveIntervalMs } : {}),
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

  it("reports its relay reservation, and the RELAY is what confirms it", async () => {
    const daemon = await start(await configFor());
    const door = `http://127.0.0.1:${daemon.localDoorPort}`;

    // Straight after start the supervisor has not yet had an answer, so what
    // this waits for is the relay itself agreeing -- the daemon's own belief
    // is exactly what proved worthless on 2026-09-19.
    const deadline = Date.now() + 15_000;
    while (daemon.relayState().verifiedAt == null) {
      if (Date.now() > deadline) throw new Error("the relay never confirmed the reservation");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const state = daemon.relayState();
    expect(state.status).toBe("reserved");
    expect(state.relayPeerId).toBe(relay.node.peerId.toString());
    expect(state.expiresAt).toBeGreaterThan(Date.now());

    const health = await doorFetch(`${door}/hub/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, relay: { healthy: true } });

    const report = await doorFetch(`${door}/hub/api/relay`);
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({
      status: "reserved",
      healthy: true,
      relayPeerId: relay.node.peerId.toString(),
    });

    // And the same report rides along on the mesh view the UI already reads.
    const mesh = (await (await doorFetch(`${door}/hub/api/mesh`)).json()) as {
      relay: { status: string };
    };
    expect(mesh.relay.status).toBe("reserved");
  }, 90_000);

  it("refuses to start without a door secret, before creating anything", async () => {
    const config = await configFor();
    const { doorSecret: _omitted, ...withoutSecret } = config;
    await expect(startDaemon(withoutSecret, [echo])).rejects.toThrow(/HUB_DOOR_SECRET/);
    await expect(startDaemon({ ...config, doorSecret: "" }, [echo])).rejects.toThrow(
      /HUB_DOOR_SECRET/,
    );
    // Refused before the identity step: nothing was written to the data dir.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(config.dataDir)).toEqual([]);
  });

  it("refuses a door request without the secret, and with a Host it does not allow", async () => {
    const daemon = await start(await configFor());
    const door = `http://127.0.0.1:${daemon.localDoorPort}`;
    for (const path of ["/", "/hub/api/mesh", `/peers/${daemon.hubPeerId}/echo/x`]) {
      expect((await fetch(`${door}${path}`)).status).toBe(401);
      expect(
        (await fetch(`${door}${path}`, { headers: { "x-hub-door-secret": "wrong" } })).status,
      ).toBe(401);
      expect((await doorFetch(`${door}${path}`)).status).not.toBe(401);
    }
    // `localhost:<port>` reaches the same socket but is not an allowed Host.
    const other = await doorFetch(`http://localhost:${daemon.localDoorPort}/hub/api/mesh`).catch(
      () => undefined,
    );
    if (other != null) expect(other.status).toBe(421);
  }, 90_000);

  it("serves a module on the local door with caller local, and 404s everything else", async () => {
    const daemon = await start(await configFor());
    expect(daemon.localDoorAddress).toBe("127.0.0.1");
    const door = `http://127.0.0.1:${daemon.localDoorPort}`;

    const res = await doorFetch(`${door}/peers/${daemon.hubPeerId}/echo/x`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/echo/x", caller: "local" });

    expect((await doorFetch(`${door}/peers/${daemon.hubPeerId}/nope/x`)).status).toBe(404);
    expect((await doorFetch(`${door}/peers/12D3KooWSomeoneElse/echo/x`)).status).toBe(404);
    expect((await doorFetch(`${door}/elsewhere`)).status).toBe(404);
    // Not the mesh mounts: the hub's own endpoints are not reachable through the door.
    expect((await doorFetch(`${door}/peers/${daemon.hubPeerId}/.well-known/mesh`)).status).toBe(
      404,
    );
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

  it("serves a member that can reach it only over the relay, and the members API says relay", async () => {
    const daemon = await start(await configFor());
    const member = await joinMember(daemon, relayOnlyNode);
    expect(member.hubLink()).toBe("relay");

    const listed = (await (
      await doorFetch(`http://127.0.0.1:${daemon.localDoorPort}/hub/api/members`)
    ).json()) as Array<{ peerId: string; link: string | null; addrs: string[] }>;
    expect(listed.find((m) => m.peerId === member.peerId)?.link).toBe("relay");

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

  it("refuses a module whose advertisement names another mount", async () => {
    const misnamed: ServiceModule = {
      ...echo,
      advertisement: { ...echo.advertisement, id: "other" },
    };
    await expect(startDaemon(await configFor(), [misnamed])).rejects.toThrow(/advertisement/);
  });

  it("refuses a revoked member's existing token, and still refuses it after a restart", async () => {
    const config = await configFor();
    const first = await start(config);
    const member = await joinMember(first, webRTCNode, 1_000);
    const echoUrl = `http://local/peers/${first.hubPeerId}/echo/x`;
    expect((await member.fetch(new Request(echoUrl))).status).toBe(200);
    const token = member.token();

    // What the admin API's revoke does: forget the member, revoke its tokens.
    first.hub.members.remove(member.peerId);
    first.hub.revocations.revoke(member.peerId);
    await first.revocationsFlushed();

    const refused = await member.fetch(new Request(echoUrl));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("revoked");
    expect(member.token()).toBe(token);

    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);
    const second = await start(config);
    expect(second.hub.isMember(member.peerId)).toBe(false);

    // The member's keepalive re-links to the restarted hub; until it has, a
    // call fails at the transport. Once it lands, the old token must be refused.
    let after: Response | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      after = await member.fetch(new Request(echoUrl)).catch(() => undefined);
      if (after != null && (after.status === 200 || after.status === 401 || after.status === 403))
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(member.token()).toBe(token);
    expect(after?.status).toBe(403);
    expect(await after?.text()).toContain("revoked");
  }, 90_000);

  it("mints an invitation through the local door's admin API; a member redeems the blob, and revoking through the door refuses its token", async () => {
    const daemon = await start(await configFor());
    const door = `http://127.0.0.1:${daemon.localDoorPort}`;

    const minted = await doorFetch(`${door}/hub/api/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles: ["member"] }),
    });
    expect(minted.status).toBe(200);
    const { blob, link } = (await minted.json()) as { blob: string; link: string };
    expect(link).toBe(`https://example.test/mesh.html?join=${blob}`);
    const joinBlob = decodeJoinBlob(blob);
    expect(joinBlob.hubPeerId).toBe(daemon.hubPeerId);

    const member = await joinWithInvitation(daemon, joinBlob.invitationId, joinBlob.relayAddrs);
    expect(member.joinedBy).toBe("redeemed");

    const echoUrl = `http://local/peers/${daemon.hubPeerId}/echo/x`;
    expect((await member.fetch(new Request(echoUrl))).status).toBe(200);

    const membersAfterJoin = (await (await doorFetch(`${door}/hub/api/members`)).json()) as Array<{
      peerId: string;
      link: string | null;
    }>;
    expect(membersAfterJoin.map((m) => m.peerId)).toContain(member.peerId);
    // A WebRTC-capable member on loopback: the hub holds an unlimited connection to it.
    expect(membersAfterJoin.find((m) => m.peerId === member.peerId)?.link).toBe(member.hubLink());

    const revoked = await doorFetch(`${door}/hub/api/members/${member.peerId}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true, removed: member.peerId });

    const refused = await member.fetch(new Request(echoUrl));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("revoked");
  }, 90_000);

  it("frees a revoked member's relay reservation: with ONE slot, the next member can still join", async () => {
    // One slot, so the second join succeeds only if the revoke released the
    // first member's reservation. The first member stays connected: a slot
    // freed by its hanging up would prove nothing about the revoke.
    const daemon = await start({ ...(await configFor()), maxReservations: 1 });
    const door = `http://127.0.0.1:${daemon.localDoorPort}`;

    const first = await joinMember(daemon, webRTCNode);
    expect(first.hubLink()).toBe("direct");

    const revoked = await doorFetch(`${door}/hub/api/members/${first.peerId}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);

    const second = await joinMember(daemon, webRTCNode);
    expect(second.hubLink()).toBe("direct");
    expect(first.hubLink()).toBe("direct");
  }, 90_000);

  it("serves the admin API on the mesh mount, gated by std:mesh.admin: a member is refused, an admin is allowed", async () => {
    const daemon = await start(await configFor());
    const member = await joinMember(daemon, webRTCNode);
    const meshApiUrl = `http://local/peers/${daemon.hubPeerId}/hub/api/mesh`;

    const asMember = await member.fetch(new Request(meshApiUrl));
    expect(asMember.status).toBe(403);

    const { id: adminInvitationId } = await daemon.hub.invitations.create(["admin"], 60_000);
    const admin = await joinWithInvitation(daemon, adminInvitationId);
    const asAdmin = await admin.fetch(new Request(meshApiUrl));
    expect(asAdmin.status).toBe(200);
    expect(await asAdmin.json()).toMatchObject({ hubPeerId: daemon.hubPeerId, services: ["echo"] });
  }, 90_000);
});
