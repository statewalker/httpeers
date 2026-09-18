/**
 * The `register-model` one-shot (compose.test.yml): registers the fake
 * upstream as model "fake" with the running LiteLLM, through the hub's own
 * `/llm` passthrough — not directly against `litellm:4000` — so this also
 * proves the passthrough and SERVER_ROOT_PATH rewrite work, not just LiteLLM
 * itself.
 *
 * Endpoint and body verified against the running image's own
 * `/peers/<id>/llm/openapi.full.json` (LiteLLM's own OpenAPI, proxied) —
 * see the task report for the exact excerpt. `x-litellm-api-key`, not
 * `Authorization`, carries the master key (global-constraints.md; measured
 * in the spike: with `litellm_key_header_name` configured, LiteLLM ignores
 * `Authorization` for this entirely).
 *
 * THE DOOR ANSWERS ONLY ITS PROXY: this presents `x-hub-door-secret` and an
 * allowed `Host`, as Traefik does. `node:http`, not `fetch`, because `fetch`
 * cannot set Host.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";

const env = readFileSync("/data/hub/hub.env", "utf8");
const match = env.match(/HUB_PEER_ID=(\S+)/);
if (!match) {
  console.error("register-model: no HUB_PEER_ID in /data/hub/hub.env");
  process.exit(1);
}
const hubPeerId = match[1];
const masterKey = process.env.LITELLM_MASTER_KEY;
if (!masterKey) {
  console.error("register-model: LITELLM_MASTER_KEY not set");
  process.exit(1);
}

const doorSecret = process.env.HUB_DOOR_SECRET;
const doorHost = (process.env.HUB_DOOR_ALLOWED_HOSTS ?? "").split(",")[0]?.trim();
if (!doorSecret || !doorHost) {
  console.error("register-model: HUB_DOOR_SECRET and HUB_DOOR_ALLOWED_HOSTS must be set");
  process.exit(1);
}

const path = `/peers/${hubPeerId}/llm/model/new`;
const body = JSON.stringify({
  model_name: "fake",
  litellm_params: {
    model: "openai/fake-model",
    api_base: "http://fake-llm:4000/v1",
    api_key: "x",
  },
});
const { status, text } = await new Promise((resolve, reject) => {
  const req = request(
    {
      host: "hub",
      port: 8787,
      method: "POST",
      path,
      headers: {
        host: doorHost,
        "x-hub-door-secret": doorSecret,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-litellm-api-key": `Bearer ${masterKey}`,
      },
    },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    },
  );
  req.on("error", reject);
  req.end(body);
});
console.log(`register-model: POST hub:8787${path} -> ${status} ${text}`);
process.exit(status >= 200 && status < 300 ? 0 : 1);
