/**
 * The `llm` module's rules and policies (spec §5.3), through the real access
 * layer — `withAccess` and biscuit, not a stand-in — the same way
 * `admin-api.test.ts`'s "behind withAccess" suite exercises `/hub/api`.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import { ruleSet, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, MESH_TOKEN_HEADER, registerPeer } from "@statewalker/httpeers-core";
import { peerIdOf, signerOf } from "@statewalker/httpeers-libp2p";
import { describe, expect, it } from "vitest";
import { llmModule } from "../src/services/llm/index.js";

describe("the llm module's rules, behind withAccess", () => {
  it("allows a member the four member-facing routes, refuses /keys and /ui/; allows an admin everything", async () => {
    const module = llmModule({ upstream: "http://litellm.test:4000", masterKey: "sk-master" });

    const hubKey = await generateKeyPair("Ed25519");
    const issuer = peerIdOf(hubKey);
    const signer = signerOf(hubKey);
    const selfPeer = issuer;

    const memberKey = await generateKeyPair("Ed25519");
    const member = peerIdOf(memberKey);
    const adminKey = await generateKeyPair("Ed25519");
    const admin = peerIdOf(adminKey);

    const memberToken = await mintToken({ signer, sub: member, roles: ["member"], ttlMs: 60_000 });
    const adminToken = await mintToken({ signer, sub: admin, roles: ["admin"], ttlMs: 60_000 });

    const rules = ruleSet({
      version: 1,
      rules: [
        'role("member") <- role("admin");', // admin implies member, as the hub's DEFAULT_RULES do
        ...module.rules,
      ],
      policies: [...module.policies],
    });

    // A handler that only reports it was reached — the point here is the
    // policy decision, not what the handler does.
    const reached = async () => new Response("ok");

    function guarded(connectionPeer: string) {
      return withAccess({ issuer, rules, selfPeer, provenPeer: () => connectionPeer })(reached);
    }

    function withBearer(path: string, token: string, peer: string): Request {
      const request = new Request(`http://hub.local${path}`, {
        headers: { [MESH_TOKEN_HEADER]: token },
      });
      registerPeer(request, peer);
      return request;
    }

    async function statusFor(role: "member" | "admin", path: string): Promise<number> {
      const [peer, token] = role === "member" ? [member, memberToken] : [admin, adminToken];
      const response = await guarded(peer)(withBearer(path, token, peer));
      return response.status;
    }

    for (const path of [
      "/llm/openapi.json",
      "/llm/v1/models",
      "/llm/v1/chat/completions",
      "/llm/v1/embeddings",
    ]) {
      expect(await statusFor("member", path), path).toBe(200);
      expect(await statusFor("admin", path), path).toBe(200);
    }

    expect(await statusFor("member", "/llm/keys")).toBe(403);
    expect(await statusFor("member", "/llm/ui/")).toBe(403);
    expect(await statusFor("admin", "/llm/keys")).toBe(200);
    expect(await statusFor("admin", "/llm/ui/")).toBe(200);

    // Minor 9: a member's capability policy names exact resource strings
    // (the `.contains($r)` array) — nothing near-miss should slip through.
    for (const path of ["/llm/v1/models-evil", "/llm/v1/models/", "/llmx"]) {
      expect(await statusFor("member", path), path).toBe(403);
    }

    // An anonymous connection has no usable token at all.
    const anon = withAccess({ issuer, rules, selfPeer, provenPeer: () => ANONYMOUS })(reached);
    expect(
      (await anon(new Request("http://hub.local/llm/v1/models"))).status,
    ).toBeGreaterThanOrEqual(400);
  });
});
