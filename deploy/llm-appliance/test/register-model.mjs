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
 */
import { readFileSync } from "node:fs";

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

const base = `http://hub:8787/peers/${hubPeerId}/llm`;
const response = await fetch(`${base}/model/new`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-litellm-api-key": `Bearer ${masterKey}`,
  },
  body: JSON.stringify({
    model_name: "fake",
    litellm_params: {
      model: "openai/fake-model",
      api_base: "http://fake-llm:4000/v1",
      api_key: "x",
    },
  }),
});
const text = await response.text();
console.log(`register-model: POST ${base}/model/new -> ${response.status} ${text}`);
process.exit(response.ok ? 0 : 1);
