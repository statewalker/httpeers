/**
 * A fake OpenAI-compatible endpoint for the smoke test.
 *
 *   GET  /v1/models              → alpha, beta
 *   POST /v1/chat/completions    → SSE, one event per word of "reply to: <last user text> (model <model>)"
 *
 * The reply to a message containing "slow" streams 60 words at 100 ms each, long enough to press
 * Stop. Requests must carry `Authorization: Bearer <apiKey>` when `apiKey` is set; otherwise 401.
 * Every response carries CORS headers: the page runs on a different origin.
 */

import { createServer } from "node:http";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeLlm({ apiKey = "test-key", port = 0 } = {}) {
  /** Completions that finished or were cut off — the smoke test waits on this, not on timing. */
  const stats = { completions: 0 };
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (apiKey !== "" && req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "beta" }, { id: "alpha" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const last = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const slow = last.includes("slow");
      const words = slow
        ? Array.from({ length: 60 }, (_, i) => `w${i}`)
        : `reply to: ${last} (model ${body.model})`.split(" ");
      res.writeHead(200, {
        ...CORS,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.on("close", () => {
        stats.completions++;
      });
      for (const [i, word] of words.entries()) {
        if (res.destroyed) return;
        const content = i === 0 ? word : ` ${word}`;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
        await sleep(slow ? 100 : 30);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404, CORS);
    res.end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${bound}/v1`,
    port: bound,
    stats,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const llm = await startFakeLlm({ port: Number(process.env.PORT ?? 4000) });
  console.log(`fake LLM at ${llm.baseUrl} (api key: test-key)`);
}
