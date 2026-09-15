/**
 * The LiteLLM passthrough (spec §5.2 rules 1-5), against a fake LiteLLM: a
 * plain `node:http` server on a random port that echoes the path and headers
 * it received, and answers a handful of fixed routes the way the spike
 * measured the real LiteLLM answering them (see
 * `docs/research/2026-09-15-llm-appliance-spikes/litellm-ui-through-mesh.md`).
 */

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPassthrough } from "../src/services/llm/passthrough.js";

const HUB_PEER_ID = "H";
const SENTINEL = "http://llm.mesh.invalid";

let server: Server;
let upstream: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (url === `/peers/${HUB_PEER_ID}/llm/v2/login` && req.method === "POST") {
      await readBody(req);
      const payload = { redirect_url: `${SENTINEL}/peers/${HUB_PEER_ID}/llm/ui/?login=success` };
      if (req.headers["x-test-gzip"] === "1") {
        const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(gz.length),
        });
        res.end(gz);
        return;
      }
      json(res, 200, payload);
      return;
    }

    // A gzip-compressed body on a path NOT in the rewrite-gated list — exercises
    // content-encoding stripping on the STREAMING branch (minor 1).
    if (url === `/peers/${HUB_PEER_ID}/llm/gzip-stream`) {
      const gz = gzipSync(Buffer.from(JSON.stringify({ ok: true })));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(gz.length),
      });
      res.end(gz);
      return;
    }

    if (url === `/peers/${HUB_PEER_ID}/llm/.well-known/litellm-ui-config`) {
      json(res, 200, { proxy_base_url: SENTINEL });
      return;
    }

    // A JSON body that happens to mention the sentinel, on a path NOT in the
    // gated list — must NOT be rewritten (spec §5.2 rule 4 names exactly two paths).
    if (url === `/peers/${HUB_PEER_ID}/llm/not-gated`) {
      json(res, 200, { note: `see ${SENTINEL}/docs` });
      return;
    }

    if (url === `/peers/${HUB_PEER_ID}/llm/redirect-upstream`) {
      res.writeHead(307, { location: `${upstream}/peers/${HUB_PEER_ID}/llm/ui/` });
      res.end();
      return;
    }

    if (url === `/peers/${HUB_PEER_ID}/llm/redirect-sentinel`) {
      res.writeHead(307, {
        location: `${SENTINEL}/peers/${HUB_PEER_ID}/llm/ui/?login=success`,
      });
      res.end();
      return;
    }

    if (url === `/peers/${HUB_PEER_ID}/llm/redirect-elsewhere`) {
      res.writeHead(307, { location: "https://example.test/somewhere" });
      res.end();
      return;
    }

    if (url === `/peers/${HUB_PEER_ID}/llm/sse`) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      await new Promise((resolve) => setTimeout(resolve, 150));
      res.write("data: second\n\n");
      res.end();
      return;
    }

    // The default: echo the path and headers, so path-construction and
    // header-hygiene tests can inspect exactly what arrived.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    json(res, 200, { path: url, headers, method: req.method });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  upstream = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe("createPassthrough", () => {
  it("rule 1: the upstream path is /peers/<hubPeerId> + the received path", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/v1/models?foo=bar"),
      HUB_PEER_ID,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe(`/peers/${HUB_PEER_ID}/llm/v1/models?foo=bar`);
  });

  it("rule 2: drops authorization and x-httpeers-peer, keeps x-litellm-api-key, never adds a master key", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/v1/models", {
        headers: {
          authorization: "Bearer mesh-token",
          "x-httpeers-peer": "12D3KooWSomePeer",
          "x-litellm-api-key": "sk-user-key",
        },
      }),
      HUB_PEER_ID,
    );
    const body = (await response.json()) as { headers: Record<string, string> };
    expect(body.headers.authorization).toBeUndefined();
    expect(body.headers["x-httpeers-peer"]).toBeUndefined();
    expect(body.headers["x-litellm-api-key"]).toBe("sk-user-key");
    // Nothing resembling a master key is ever added: this passthrough
    // constructor takes no master key at all (see PassthroughInit) — the
    // strongest guarantee available. As a runtime check: no authorization
    // header appears when the caller sent none.
    const noAuthCase = await passthrough(
      new Request("http://mesh.local/llm/v1/models"),
      HUB_PEER_ID,
    );
    const noAuthBody = (await noAuthCase.json()) as { headers: Record<string, string> };
    expect(noAuthBody.headers.authorization).toBeUndefined();
  });

  it("rule 3: rewrites a Location at the upstream origin to root-relative", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/redirect-upstream", { redirect: "manual" }),
      HUB_PEER_ID,
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/peers/${HUB_PEER_ID}/llm/ui/`);
  });

  it("rule 3: rewrites a Location at the sentinel origin to root-relative", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/redirect-sentinel", { redirect: "manual" }),
      HUB_PEER_ID,
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/peers/${HUB_PEER_ID}/llm/ui/?login=success`);
  });

  it("rule 3: leaves a Location at an unrelated origin untouched", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/redirect-elsewhere", { redirect: "manual" }),
      HUB_PEER_ID,
    );
    expect(response.headers.get("location")).toBe("https://example.test/somewhere");
  });

  it("rule 4: rewrites the /v2/login JSON body, dropping content-length", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/v2/login", { method: "POST", body: "{}" }),
      HUB_PEER_ID,
    );
    const body = (await response.json()) as { redirect_url: string };
    expect(body.redirect_url).toBe(`/peers/${HUB_PEER_ID}/llm/ui/?login=success`);
    expect(response.headers.has("content-length")).toBe(false);
  });

  it("rule 4: rewrites the .well-known/litellm-ui-config JSON body", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/.well-known/litellm-ui-config"),
      HUB_PEER_ID,
    );
    const body = (await response.json()) as { proxy_base_url: string };
    expect(body.proxy_base_url).toBe("");
  });

  it("rule 4: leaves a JSON body on any other path untouched", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(new Request("http://mesh.local/llm/not-gated"), HUB_PEER_ID);
    const body = (await response.json()) as { note: string };
    expect(body.note).toBe(`see ${SENTINEL}/docs`);
  });

  it("minor 1: drops content-encoding and content-length on a gzipped rewritten body", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/v2/login", {
        method: "POST",
        body: "{}",
        headers: { "x-test-gzip": "1" },
      }),
      HUB_PEER_ID,
    );
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    const body = (await response.json()) as { redirect_url: string };
    // Still correctly decompressed AND rewritten, not just header-stripped.
    expect(body.redirect_url).toBe(`/peers/${HUB_PEER_ID}/llm/ui/?login=success`);
  });

  it("minor 1: drops content-encoding and content-length on a gzipped streamed body", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(
      new Request("http://mesh.local/llm/gzip-stream"),
      HUB_PEER_ID,
    );
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("streams a body incrementally rather than buffering it (SSE)", async () => {
    const passthrough = createPassthrough({ upstream });
    const response = await passthrough(new Request("http://mesh.local/llm/sse"), HUB_PEER_ID);
    expect(response.body).not.toBeNull();
    const reader = response.body?.getReader();
    if (reader == null) throw new Error("no body reader");

    const first = await reader.read();
    const firstAt = Date.now();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value ?? new Uint8Array()).toString("utf8")).toContain("first");

    let lastAt = firstAt;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      lastAt = Date.now();
    }
    // The fake upstream waits 150 ms between chunks; a passthrough that
    // buffered the whole SSE body would see both writes before returning
    // anything, collapsing this gap to ~0.
    expect(lastAt - firstAt).toBeGreaterThan(80);
  });

  it("rule 5: an unreachable upstream is reported as 502 { error, kind: upstream-unreachable }, never naming the upstream", async () => {
    // Port 1 is a reserved, never-listening port on loopback.
    const unreachableUpstream = "http://127.0.0.1:1";
    const passthrough = createPassthrough({ upstream: unreachableUpstream });
    const response = await passthrough(new Request("http://mesh.local/llm/v1/models"), HUB_PEER_ID);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; kind: string };
    expect(body.kind).toBe("upstream-unreachable");
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toContain(unreachableUpstream);
    expect(body.error).not.toContain("127.0.0.1");
  });

  it("rule 5: an opaque redirect from upstream is its own kind, upstream-redirect, never naming the upstream", async () => {
    // `new Response(body, { status: 0 })` throws (confirmed directly), which
    // is exactly why `urlUpstream` reports THIS via `response.type` instead —
    // fabricate that with a fetch double, the only way to reach this branch
    // outside a real browser/service-worker opaque redirect.
    const fakeFetch = (async () => {
      const opaque = new Response("redirected", { status: 200 });
      Object.defineProperty(opaque, "type", { value: "opaqueredirect", configurable: true });
      return opaque;
    }) as typeof fetch;
    const passthrough = createPassthrough({ upstream, fetchImpl: fakeFetch });
    const response = await passthrough(new Request("http://mesh.local/llm/v1/models"), HUB_PEER_ID);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; kind: string };
    expect(body.kind).toBe("upstream-redirect");
    expect(body.error).not.toContain(upstream);
  });
});
