/**
 * `llmModule` itself: routing dispatch and — minor 3 — upstream
 * normalization, so a trailing slash on `HUB_LLM_UPSTREAM` cannot make
 * `passthrough.ts` and `keys.ts` disagree (one stripping it, one not) and
 * produce a doubled slash in the upstream request path.
 */

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceContext } from "../src/service-module.js";
import { llmModule } from "../src/services/llm/index.js";

const HUB_PEER_ID = "H";
const CONTEXT: ServiceContext = { hubPeerId: HUB_PEER_ID, edgeKey: "peers", caller: "mesh" };

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

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    await readBody(req);
    // Fails the test outright if a doubled slash ever reaches the upstream.
    if (url.includes("//")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "doubled slash", url }));
      return;
    }
    if (url === `/peers/${HUB_PEER_ID}/llm/key/generate`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ key: "sk-new", key_alias: "a", expires: null }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: url }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  upstream = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe("llmModule", () => {
  it("minor 3: a trailing slash on the upstream does not double up in the passthrough path", async () => {
    const module = llmModule({ upstream: `${upstream}/`, masterKey: "sk-master" });
    const response = await module.handler(new Request("http://mesh.local/llm/v1/models"), CONTEXT);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe(`/peers/${HUB_PEER_ID}/llm/v1/models`);
  });

  it("minor 3: a trailing slash on the upstream does not double up in the keys path", async () => {
    const module = llmModule({ upstream: `${upstream}/`, masterKey: "sk-master" });
    const response = await module.handler(
      new Request("http://mesh.local/llm/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key_alias: "a" }),
      }),
      CONTEXT,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: "sk-new", key_alias: "a", expires: null });
  });

  it("routes /llm/openapi.json to the curated document, not upstream", async () => {
    const module = llmModule({ upstream, masterKey: "sk-master" });
    const response = await module.handler(
      new Request("http://mesh.local/llm/openapi.json"),
      CONTEXT,
    );
    const body = (await response.json()) as { servers: Array<{ url: string }> };
    expect(body.servers).toEqual([{ url: "." }]);
  });

  it("routes /llm/openapi.full.json to upstream's openapi.json", async () => {
    const module = llmModule({ upstream, masterKey: "sk-master" });
    const response = await module.handler(
      new Request("http://mesh.local/llm/openapi.full.json"),
      CONTEXT,
    );
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe(`/peers/${HUB_PEER_ID}/llm/openapi.json`);
  });
});
