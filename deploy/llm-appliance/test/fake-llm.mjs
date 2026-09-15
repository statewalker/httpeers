/**
 * A fake OpenAI-compatible upstream for the local smoke test
 * (compose.test.yml's `fake-llm` service) — LiteLLM calls this, not a
 * browser, so unlike `apps/llm-chat/scripts/fake-llm.mjs` (which this is
 * adapted from) there is no CORS and no API-key check: LiteLLM is configured
 * with `api_key: "x"` for this model (compose.test.yml's `register-model`),
 * and this never verifies it.
 *
 *   GET  /v1/models              -> fake
 *   POST /v1/chat/completions    -> SSE, one event per word of
 *                                   "reply to: <last user text> (model <model>)"
 *
 * Listens on 0.0.0.0:4000 (PORT overrides), reachable from other appliance
 * containers as http://fake-llm:4000/v1.
 */

import { createServer } from "node:http";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeLlm({ port = 4000 } = {}) {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
        return;
      }
      const last =
        [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
      const words = `reply to: ${last} (model ${body.model})`.split(" ");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [i, word] of words.entries()) {
        if (res.destroyed) return;
        const content = i === 0 ? word : ` ${word}`;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
        await sleep(20);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4000);
  await startFakeLlm({ port });
  console.log(`fake LLM at http://0.0.0.0:${port}/v1`);
}
