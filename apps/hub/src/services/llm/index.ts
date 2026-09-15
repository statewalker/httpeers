/**
 * The `llm` service module — a passthrough to LiteLLM under the mesh root
 * path (spec §4.2, §5.1-§5.3).
 *
 * ROUTING, most-specific first:
 *   - `GET /llm/openapi.json`      -> the curated document (`openapi.ts`), built once;
 *   - `GET /llm/openapi.full.json` -> upstream `/peers/<hubPeerId>/llm/openapi.json`,
 *     via the same passthrough that serves everything else (rewritten to ask
 *     for `openapi.json`, LiteLLM's own route — see the handler below);
 *   - `POST /llm/keys`             -> `keys.ts`, method-gated here so every
 *     other verb on that path 405s instead of falling through to LiteLLM,
 *     which has no route there at all;
 *   - everything else              -> `passthrough.ts`.
 *
 * RULES AND POLICIES ARE SPEC §5.3, VERBATIM. The array-literal `.contains($r)`
 * form and the `resource("/llm") or ... starts_with("/llm/")` form both parse
 * under this repo's biscuit-wasm engine (checked directly against
 * `Policy.fromString` before writing this file) — no `or`-chain substitution
 * was needed.
 */

import type { ServiceModule } from "../../service-module.js";
import { createKeys } from "./keys.js";
import { buildLlmOpenApi } from "./openapi.js";
import { createPassthrough } from "./passthrough.js";

export interface LlmModuleInit {
  /** `HUB_LLM_UPSTREAM`, e.g. `http://litellm:4000`. */
  upstream: string;
  /** `LITELLM_MASTER_KEY`. */
  masterKey: string;
}

const OPENAPI_JSON = "/llm/openapi.json";
const OPENAPI_FULL_JSON = "/llm/openapi.full.json";
const KEYS_PATH = "/llm/keys";

/** Spec §5.3, verbatim. */
const RULES = [
  'capability("app:llm.use")   <- role("member");',
  'capability("app:llm.admin") <- role("admin");',
];

/** Spec §5.3, verbatim. */
const POLICIES = [
  'allow if capability("app:llm.use"), resource($r),' +
    ' ["/llm/openapi.json","/llm/v1/models","/llm/v1/chat/completions","/llm/v1/embeddings"].contains($r);',
  'allow if capability("app:llm.admin"), resource("/llm")' +
    ' or capability("app:llm.admin"), resource($r), $r.starts_with("/llm/");',
];

/** Build the `llm` service module — see the module comment for its routing. */
export function llmModule(init: LlmModuleInit): ServiceModule {
  const passthrough = createPassthrough({ upstream: init.upstream });
  const keys = createKeys({ upstream: init.upstream, masterKey: init.masterKey });
  const openapiDocument = buildLlmOpenApi();

  return {
    id: "llm",
    advertisement: { id: "llm", kind: "openapi-service", title: "LLM" },
    rules: RULES,
    policies: POLICIES,
    async handler(request, context) {
      const url = new URL(request.url);

      if (url.pathname === OPENAPI_JSON && request.method === "GET") {
        return Response.json(openapiDocument);
      }

      if (url.pathname === OPENAPI_FULL_JSON) {
        if (request.method !== "GET") {
          return Response.json(
            { error: "llm: /openapi.full.json accepts GET only" },
            { status: 405 },
          );
        }
        // LiteLLM's own route is `openapi.json`, not `openapi.full.json`; only
        // the path this hub exposes it under differs.
        const upstreamRequest = new Request(new URL(OPENAPI_JSON, url.origin), {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
        });
        return passthrough(upstreamRequest, context.hubPeerId);
      }

      if (url.pathname === KEYS_PATH) {
        if (request.method !== "POST") {
          return Response.json({ error: "llm: /keys accepts POST only" }, { status: 405 });
        }
        return keys(request, context.hubPeerId);
      }

      return passthrough(request, context.hubPeerId);
    },
  };
}
