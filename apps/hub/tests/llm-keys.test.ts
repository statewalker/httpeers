/**
 * `POST /llm/keys` (spec §5.2): field filtering, the master-key auth header,
 * response mapping, and error mapping — against a fake LiteLLM `key/generate`.
 */

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKeys } from "../src/services/llm/keys.js";

const HUB_PEER_ID = "H";
const MASTER_KEY = "sk-master-secret";

let server: Server;
let upstream: string;
let lastRequest: { url: string; headers: Record<string, string>; body: unknown } | undefined;
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
let nextRedirect: string | undefined;
let delayMs = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    lastRequest = { url: req.url ?? "/", headers, body: raw === "" ? undefined : JSON.parse(raw) };

    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    if (nextRedirect != null) {
      res.writeHead(307, { location: nextRedirect });
      res.end();
      return;
    }

    res.writeHead(nextResponse.status, { "content-type": "application/json" });
    res.end(JSON.stringify(nextResponse.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  upstream = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  nextRedirect = undefined;
  delayMs = 0;
});

afterAll(() => {
  server.close();
});

function req(body: unknown, method = "POST"): Request {
  return new Request("http://mesh.local/llm/keys", {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

describe("createKeys", () => {
  it("forwards to /peers/<id>/llm/key/generate with x-litellm-api-key: Bearer <masterKey>, never Authorization", async () => {
    // IMPORTANT 1: the appliance sets litellm_key_header_name to
    // x-litellm-api-key, so real LiteLLM reads the master key ONLY from that
    // header and ignores Authorization entirely (spike Q3, measured) — the
    // mesh token's own header must stay unused here.
    nextResponse = { status: 200, body: { key: "sk-new", key_alias: "a", expires: null } };
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const response = await keys(req({ key_alias: "a" }), HUB_PEER_ID);
    expect(response.status).toBe(200);
    expect(lastRequest?.url).toBe(`/peers/${HUB_PEER_ID}/llm/key/generate`);
    expect(lastRequest?.headers["x-litellm-api-key"]).toBe(`Bearer ${MASTER_KEY}`);
    expect(lastRequest?.headers.authorization).toBeUndefined();
    expect(lastRequest?.headers["content-type"]).toContain("application/json");
  });

  it("forwards only the allowed fields, dropping everything else", async () => {
    nextResponse = { status: 200, body: { key: "sk-new", key_alias: "a", expires: null } };
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    await keys(
      req({
        key_alias: "a",
        user_id: "u1",
        models: ["gpt-4"],
        max_budget: 10,
        budget_duration: "30d",
        duration: "1d",
        tpm_limit: 100,
        rpm_limit: 5,
        metadata: { team: "x" },
        // Not in the allowed list — must be dropped.
        admin: true,
        role: "proxy_admin",
        rpm_limit_override_everything: 99999,
      }),
      HUB_PEER_ID,
    );
    expect(lastRequest?.body).toEqual({
      key_alias: "a",
      user_id: "u1",
      models: ["gpt-4"],
      max_budget: 10,
      budget_duration: "30d",
      duration: "1d",
      tpm_limit: 100,
      rpm_limit: 5,
      metadata: { team: "x" },
    });
  });

  it("maps the upstream response to { key, key_alias, expires }, dropping everything else", async () => {
    nextResponse = {
      status: 200,
      body: { key: "sk-new", key_alias: "a", expires: "2027-01-01T00:00:00Z", extra: "ignored" },
    };
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const response = await keys(req({ key_alias: "a" }), HUB_PEER_ID);
    expect(await response.json()).toEqual({
      key: "sk-new",
      key_alias: "a",
      expires: "2027-01-01T00:00:00Z",
    });
  });

  it("maps a non-2xx upstream response to the same status with kind upstream-error", async () => {
    nextResponse = { status: 403, body: { detail: "not allowed" } };
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const response = await keys(req({ key_alias: "a" }), HUB_PEER_ID);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; kind: string; detail: unknown };
    expect(body.kind).toBe("upstream-error");
    expect(body.detail).toEqual({ detail: "not allowed" });
  });

  it("a 2xx response without a string key is 502 { error, kind: upstream-error }", async () => {
    nextResponse = { status: 200, body: { key_alias: "a", expires: null } }; // no `key`
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const response = await keys(req({ key_alias: "a" }), HUB_PEER_ID);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; kind: string };
    expect(body.kind).toBe("upstream-error");
  });

  it("minor 5: never follows a redirect (and so never re-sends the master key to it); reports upstream-error", async () => {
    nextRedirect = "http://evil.test/steal-the-key";
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const response = await keys(req({ key_alias: "a" }), HUB_PEER_ID);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; kind: string };
    expect(body.kind).toBe("upstream-error");
    // The fake server only ever sees the ORIGINAL request (this test's own
    // upstream); nothing here proves a second request to evil.test never
    // happened over the network, but `redirect: "manual"` is what makes that
    // structurally true — Node's fetch never dereferences the Location itself.
  });

  it("minor 5: forwards the caller's abort signal to the upstream call", async () => {
    delayMs = 2_000;
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const controller = new AbortController();
    const request = new Request("http://mesh.local/llm/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key_alias: "a" }),
      signal: controller.signal,
    });
    const pending = keys(request, HUB_PEER_ID);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(502);
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("upstream-error");
  });

  it("400s an invalid body (not JSON, or not an object)", async () => {
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const notJson = await keys(
      new Request("http://mesh.local/llm/keys", { method: "POST", body: "not json" }),
      HUB_PEER_ID,
    );
    expect(notJson.status).toBe(400);

    const arrayBody = await keys(req([1, 2, 3]), HUB_PEER_ID);
    expect(arrayBody.status).toBe(400);
  });

  it("405s a non-POST call", async () => {
    const keys = createKeys({ upstream, masterKey: MASTER_KEY });
    const response = await keys(req(undefined, "GET"), HUB_PEER_ID);
    expect(response.status).toBe(405);
  });
});
