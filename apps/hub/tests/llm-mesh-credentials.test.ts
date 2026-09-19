/**
 * The LiteLLM Playground, through the mesh — the defect this pins, end to end
 * through the real access layer and the real `llm` module.
 *
 * MEASURED LIVE: the Playground calls `/v1/chat/completions` through the OpenAI
 * SDK, which always sends its key as `Authorization: Bearer sk-...`. While the
 * mesh token also lived in `Authorization`, the page's edge would not overwrite
 * the page's value, so `withAccess` tried to verify the LiteLLM key as a mesh
 * token and answered `401 "malformed token"` — LiteLLM never saw the call.
 *
 * With the mesh token in `MESH_TOKEN_HEADER` the two credentials travel side by
 * side: the mesh reads its own, LiteLLM gets the key (moved to the
 * `x-litellm-api-key` header the appliance configures), and neither mesh header
 * reaches LiteLLM.
 */

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { ruleSet, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { MESH_TOKEN_HEADER, PEER_ID_HEADER, registerPeer } from "@statewalker/httpeers-core";
import { peerIdOf, signerOf } from "@statewalker/httpeers-libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { llmModule } from "../src/services/llm/index.js";

let server: Server;
let upstream: string;

beforeAll(async () => {
  // A fake LiteLLM that echoes the headers it received.
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("a Playground call through the mesh", () => {
  it("is authorised by the mesh token and reaches LiteLLM with the Playground's own key", async () => {
    const module = llmModule({ upstream, masterKey: "sk-master" });

    const hubKey = await generateKeyPair("Ed25519");
    const issuer = peerIdOf(hubKey);
    const member = peerIdOf(await generateKeyPair("Ed25519"));
    const meshToken = await mintToken({
      signer: signerOf(hubKey),
      sub: member,
      roles: ["member"],
      ttlMs: 60_000,
    });
    const rules = ruleSet({ version: 1, rules: [...module.rules], policies: [...module.policies] });

    const handler = withAccess({ issuer, rules, selfPeer: issuer, provenPeer: () => member })(
      (request) => module.handler(request, { hubPeerId: issuer, edgeKey: "peers", caller: "mesh" }),
    );

    const request = new Request("http://hub.local/llm/v1/chat/completions", {
      method: "POST",
      headers: {
        [MESH_TOKEN_HEADER]: meshToken,
        authorization: "Bearer sk-ui-session-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-haiku-4.5", messages: [] }),
    });
    registerPeer(request, member);

    const response = await handler(request);

    expect(response.status).toBe(200);
    const echoed = (await response.json()) as { path: string; headers: Record<string, string> };
    expect(echoed.path).toBe(`/peers/${issuer}/llm/v1/chat/completions`);
    expect(echoed.headers["x-litellm-api-key"]).toBe("Bearer sk-ui-session-key");
    expect(echoed.headers.authorization).toBeUndefined();
    expect(echoed.headers[MESH_TOKEN_HEADER]).toBeUndefined();
    expect(echoed.headers[PEER_ID_HEADER]).toBeUndefined();
  });
});
