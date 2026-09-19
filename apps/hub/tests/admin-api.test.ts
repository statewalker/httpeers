/**
 * The admin REST API (spec §5.4), against an in-memory hub — every route's
 * happy path, its error cases, and the OpenAPI document it publishes about
 * itself. The rule-evaluation test at the bottom is the one place this file
 * goes through `withAccess` for real: the point is that `/hub/api/*` is
 * governed by the SAME policy the mesh mount uses, not a stand-in.
 *
 * The daemon-level round trip — a real invitation minted through the local
 * door, redeemed by a Node member, then revoked through the door — lives in
 * `daemon.test.ts`, which already has the relay and member harness this would
 * otherwise have to duplicate.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import { type RuleSet, ruleSet, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, MESH_TOKEN_HEADER, registerPeer } from "@statewalker/httpeers-core";
import { createHub, type Hub, memoryStorage } from "@statewalker/httpeers-hub";
import { peerIdOf, signerOf } from "@statewalker/httpeers-libp2p";
import { describe, expect, it } from "vitest";
import { createAdminApi } from "../src/admin-api.js";
import { linkOf, type MemberLink } from "../src/member-link.js";
import { CORE_POLICIES } from "../src/rules.js";

const HUB_PEER_ID = "12D3KooWHubAdminApiTestAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RELAY_ADDRS = [`/dns4/relay.test/tcp/443/wss/p2p-circuit/p2p/${HUB_PEER_ID}`];
const JOIN_PAGE_URL = "https://example.test/mesh.html";

const RULES: RuleSet = ruleSet({
  version: 1,
  rules: [
    'capability("std:mesh.admin") <- role("admin");',
    'role("member")               <- role("admin");',
  ],
  policies: [...CORE_POLICIES],
});

const stubMintToken = async (sub: string, roles: string[]) => `token:${sub}:${roles.join("+")}`;

interface Setup {
  hub: Hub;
  now: () => number;
  api: (request: Request) => Promise<Response>;
}

async function setup(
  now: () => number = () => 1_700_000_000_000,
  links: Record<string, MemberLink> = {},
): Promise<Setup> {
  const hub = await createHub({
    selfPeerId: HUB_PEER_ID,
    mintToken: stubMintToken,
    policies: RULES,
    storage: memoryStorage(),
    now,
  });
  const api = createAdminApi({
    hub,
    hubPeerId: HUB_PEER_ID,
    relayAddrs: RELAY_ADDRS,
    joinPageUrl: JOIN_PAGE_URL,
    rules: RULES,
    services: ["echo"],
    linkOf: (peerId) => links[peerId] ?? null,
    revoke: async (subject) => {
      hub.members.remove(subject);
      hub.revocations.revoke(subject);
    },
  });
  return { hub, now, api };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://hub.local${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

describe("createAdminApi", () => {
  it("GET /hub/api/mesh: the mesh view plus hubPeerId, relayAddrs and services", async () => {
    const { api, hub } = await setup();
    const res = await api(req("GET", "/hub/api/mesh"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      self: HUB_PEER_ID,
      hubPeerId: HUB_PEER_ID,
      relayAddrs: RELAY_ADDRS,
      services: ["echo"],
    });
    expect(body.version).toBe(hub.meshView().version);
    expect(body.members).toEqual([]);
    expect(body.advertisements).toEqual([]);
  });

  it("GET /hub/api/roles: roleNames(rules)", async () => {
    const { api } = await setup();
    const res = await api(req("GET", "/hub/api/roles"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["admin", "member"]);
  });

  describe("POST /hub/api/invitations", () => {
    it("mints an invitation with the default 24h ttl", async () => {
      const T = 1_700_000_000_000;
      const { api } = await setup(() => T);
      const res = await api(req("POST", "/hub/api/invitations", { roles: ["member"] }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        expiresAt: number;
        blob: string;
        link: string;
      };
      expect(typeof body.id).toBe("string");
      expect(body.expiresAt).toBe(T + 24 * 60 * 60 * 1000);
      expect(body.link.startsWith(JOIN_PAGE_URL)).toBe(true);
      expect(new URL(body.link).searchParams.get("join")).toBe(body.blob);
    });

    it("honours an explicit ttlMs", async () => {
      const T = 1_700_000_000_000;
      const { api } = await setup(() => T);
      const res = await api(
        req("POST", "/hub/api/invitations", { roles: ["member"], ttlMs: 60_000 }),
      );
      const body = (await res.json()) as { expiresAt: number };
      expect(body.expiresAt).toBe(T + 60_000);
    });

    it("400s on an unknown role", async () => {
      const { api } = await setup();
      const res = await api(req("POST", "/hub/api/invitations", { roles: ["superadmin"] }));
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("superadmin"),
      });
    });

    it("400s on a body that is not { roles: string[] }", async () => {
      const { api } = await setup();
      expect((await api(req("POST", "/hub/api/invitations", { roles: "member" }))).status).toBe(
        400,
      );
      expect((await api(req("POST", "/hub/api/invitations", {}))).status).toBe(400);
    });

    it("400s on malformed JSON", async () => {
      const { api } = await setup();
      const bad = new Request("http://hub.local/hub/api/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      });
      expect((await api(bad)).status).toBe(400);
    });
  });

  it("GET /hub/api/invitations: pending invitations", async () => {
    const { api, hub } = await setup();
    expect(await (await api(req("GET", "/hub/api/invitations"))).json()).toEqual([]);

    await hub.invitations.create(["member"], 60_000, { id: "inv-1" });
    const res = await api(req("GET", "/hub/api/invitations"));
    expect(await res.json()).toEqual([
      { id: "inv-1", roles: ["member"], expiresAt: expect.any(Number) },
    ]);
  });

  describe("members", () => {
    it("GET /hub/api/members: roles, online state, and the link the hub sees", async () => {
      const { api, hub } = await setup(undefined, {
        "12D3KooWMemberDirect": "direct",
        "12D3KooWMemberRelay": "relay",
      });
      hub.members.add("12D3KooWMemberOne", ["member"]);
      hub.members.add("12D3KooWMemberDirect", ["member"]);
      hub.members.add("12D3KooWMemberRelay", ["admin"]);
      const res = await api(req("GET", "/hub/api/members"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ peerId: string }>;
      expect(body.sort((a, b) => a.peerId.localeCompare(b.peerId))).toEqual([
        {
          peerId: "12D3KooWMemberDirect",
          roles: ["member"],
          online: false,
          addrs: [],
          link: "direct",
        },
        { peerId: "12D3KooWMemberOne", roles: ["member"], online: false, addrs: [], link: null },
        {
          peerId: "12D3KooWMemberRelay",
          roles: ["admin"],
          online: false,
          addrs: [],
          link: "relay",
        },
      ]);
    });

    it("DELETE /hub/api/members/:peerId then GET: removed and revoked, persisted", async () => {
      const { api, hub } = await setup();
      hub.members.add("12D3KooWMemberOne", ["member"]);

      const del = await api(req("DELETE", "/hub/api/members/12D3KooWMemberOne"));
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true, removed: "12D3KooWMemberOne" });

      expect(hub.isMember("12D3KooWMemberOne")).toBe(false);
      expect(hub.revocations.list().map((e) => e.peerId)).toEqual(["12D3KooWMemberOne"]);

      const list = await api(req("GET", "/hub/api/members"));
      expect(await list.json()).toEqual([]);
    });

    it("DELETE on an unknown member: 404", async () => {
      const { api } = await setup();
      const res = await api(req("DELETE", "/hub/api/members/12D3KooWNoSuchMember"));
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toHaveProperty("error");
    });

    it("DELETE with a malformed percent-escape in the peerId: 400, not a thrown exception", async () => {
      const { api } = await setup();
      // "%E0%A4%A" is a truncated escape sequence -- decodeURIComponent throws
      // a URIError on it.
      const res = await api(req("DELETE", "/hub/api/members/%E0%A4%A"));
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toHaveProperty("error");
    });
  });

  it("GET /hub/api/openapi.json: every route in the table", async () => {
    const { api } = await setup();
    const res = await api(req("GET", "/hub/api/openapi.json"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        "/hub/api/mesh",
        "/hub/api/roles",
        "/hub/api/invitations",
        "/hub/api/members",
        "/hub/api/members/{peerId}",
        "/hub/api/openapi.json",
      ].sort(),
    );
  });

  it("404s a path this API does not serve", async () => {
    const { api } = await setup();
    expect((await api(req("GET", "/hub/api/nope"))).status).toBe(404);
  });
});

describe("linkOf (the daemon's connection lookup)", () => {
  const conn = (peer: string, status: string, limits?: object) => ({
    remotePeer: { toString: () => peer },
    status,
    limits,
  });
  const nodeWith = (connections: ReturnType<typeof conn>[]) =>
    ({ getConnections: () => connections }) as unknown as Parameters<typeof linkOf>[0];

  it("is direct when any open connection to the peer is unlimited", () => {
    const node = nodeWith([conn("P", "open", { bytes: 1n }), conn("P", "open")]);
    expect(linkOf(node, "P")).toBe("direct");
  });

  it("is relay when only limited connections are open", () => {
    const node = nodeWith([conn("P", "open", { bytes: 1n }), conn("P", "closed")]);
    expect(linkOf(node, "P")).toBe("relay");
  });

  it("is null with no open connection to that peer", () => {
    const node = nodeWith([conn("Q", "open"), conn("P", "closing"), conn("P", "closed")]);
    expect(linkOf(node, "P")).toBeNull();
  });
});

describe("createAdminApi, behind withAccess", () => {
  it("refuses a member, allows an admin, on /hub/api/invitations", async () => {
    const { api } = await setup();

    const hubKey = await generateKeyPair("Ed25519");
    const issuer = peerIdOf(hubKey);
    const signer = signerOf(hubKey);

    const memberKey = await generateKeyPair("Ed25519");
    const member = peerIdOf(memberKey);
    const adminKey = await generateKeyPair("Ed25519");
    const admin = peerIdOf(adminKey);

    const memberToken = await mintToken({ signer, sub: member, roles: ["member"], ttlMs: 60_000 });
    const adminToken = await mintToken({ signer, sub: admin, roles: ["admin"], ttlMs: 60_000 });

    function guarded(connectionPeer: string) {
      return withAccess({
        issuer,
        rules: RULES,
        selfPeer: HUB_PEER_ID,
        provenPeer: () => connectionPeer,
      })(api);
    }

    function withBearer(path: string, token: string, peer: string): Request {
      const request = new Request(`http://hub.local${path}`, {
        headers: { [MESH_TOKEN_HEADER]: token },
      });
      registerPeer(request, peer);
      return request;
    }

    const memberResponse = await guarded(member)(
      withBearer("/hub/api/invitations", memberToken, member),
    );
    expect(memberResponse.status).toBe(403);

    const adminResponse = await guarded(admin)(
      withBearer("/hub/api/invitations", adminToken, admin),
    );
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toEqual([]);
  });

  it("refuses an anonymous connection outright", async () => {
    const { api } = await setup();
    const handler = withAccess({
      issuer: HUB_PEER_ID,
      rules: RULES,
      selfPeer: HUB_PEER_ID,
      provenPeer: () => ANONYMOUS,
    })(api);
    const res = await handler(new Request("http://hub.local/hub/api/invitations"));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
