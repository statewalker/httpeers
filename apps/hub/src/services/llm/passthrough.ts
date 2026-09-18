/**
 * The LiteLLM passthrough — spec §5.2's five measured rules.
 *
 * PATHS (rule 1). The handler is called with the browser-visible path already
 * mesh-mounted (`/llm/...`, the mount's own path — see `service-module.ts`'s
 * header comment). `urlUpstream`'s `base` carries the rest: `.${pathname}`
 * resolved against `<upstream>/peers/<hubPeerId>/` lands on
 * `<upstream>/peers/<hubPeerId>/llm/...`, exactly LiteLLM's configured
 * `SERVER_ROOT_PATH`. A fresh `urlUpstream` is built per call because
 * `hubPeerId` is a per-REQUEST value here (`ServiceContext`), not a
 * construction-time one — cheap, since it is just a closure.
 *
 * HEADERS (rule 2). `urlUpstream` already drops `authorization` (a LiteLLM
 * key the dashboard put there is moved to `x-litellm-api-key` first -- see
 * `moveDashboardKey`) and
 * hop-by-hop headers; `stripRequestHeaders: [PEER_ID_HEADER]` drops the
 * proven-peer header too. No `headers` or `credential` is configured here, so
 * the master key is never added — it belongs to `keys.ts` alone.
 *
 * REDIRECTS AND BODIES (rules 3-4) are `rewrite.ts`'s job; this file only
 * decides WHEN to buffer (the two gated endpoints) versus stream (everything
 * else, including SSE).
 *
 * ERRORS (rule 5). `urlUpstream` reports an unreachable upstream, and
 * separately an opaque redirect, as a 502 with its own `MARKER` header and a
 * plain-text body; this rewraps each into the spec's `{ error, kind }` JSON
 * shape, kept apart (`upstream-unreachable` vs `upstream-redirect`) and never
 * naming the internal upstream URL in the error text — that would leak a
 * private address to whoever triggered the failure.
 *
 * CONTENT-ENCODING. undici's `fetch` transparently decompresses a gzip/br
 * body but leaves the original `content-encoding` and `content-length`
 * headers on the `Response` object (measured directly against a fake gzipping
 * server). Passed through unchanged, those would tell the caller the body is
 * still encoded, or give it the compressed byte count for an already
 * decompressed stream — both wrong. Both headers are dropped whenever
 * `content-encoding` is present, before either branch below.
 */

import { PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { MARKER, urlUpstream } from "@statewalker/webrun-http-proxy";
import { rewriteLocation, shouldRewriteBody, stripOrigins } from "./rewrite.js";

export const SENTINEL_ORIGINS = ["http://llm.mesh.invalid", "https://llm.mesh.invalid"] as const;

export interface PassthroughInit {
  /** `HUB_LLM_UPSTREAM`, e.g. `http://litellm:4000`. */
  upstream: string;
  /** Injected by tests; defaults to the platform's. */
  fetchImpl?: typeof fetch;
}

export type Passthrough = (request: Request, hubPeerId: string) => Promise<Response>;

/** Never the internal upstream address — see the module comment on why. */
const MARKER_ERROR_TEXT: Record<string, string> = {
  "upstream-redirect": "llm: upstream redirected unexpectedly",
  "upstream-unreachable": "llm: upstream unreachable",
};

/** A LiteLLM key: `sk-` then key characters. A mesh token (base64url) never starts with `sk-`. */
const LITELLM_BEARER = /^Bearer sk-\S+$/;

/**
 * LiteLLM's dashboard sends its key as `Authorization: Bearer sk-...` until it
 * has read `litellm_key_header_name` from `/get/ui_settings`, and as
 * `x-litellm-api-key` after that. Every call it makes before that point would
 * lose its key with the dropped `authorization` (rule 2) and get a 401, so a
 * LiteLLM-shaped bearer is moved to `x-litellm-api-key` when that header is
 * absent. Anything else in `authorization` -- the mesh's own token -- is still
 * dropped, never forwarded.
 */
function moveDashboardKey(request: Request): Request {
  const authorization = request.headers.get("authorization");
  if (authorization == null || request.headers.has("x-litellm-api-key")) return request;
  if (!LITELLM_BEARER.test(authorization)) return request;
  const headers = new Headers(request.headers);
  headers.set("x-litellm-api-key", authorization);
  headers.delete("authorization");
  return new Request(request, { headers });
}

/**
 * Build the passthrough handler — see the module comment for the rules it
 * implements. `init.upstream` is expected already normalized (no trailing
 * slash) — `llmModule` does that once, so this and `keys.ts` always agree.
 */
export function createPassthrough(init: PassthroughInit): Passthrough {
  const upstreamOrigin = new URL(init.upstream).origin;
  const origins: readonly string[] = [upstreamOrigin, ...SENTINEL_ORIGINS];

  return async (incoming, hubPeerId) => {
    const request = moveDashboardKey(incoming);
    const forward = urlUpstream({
      base: `${init.upstream}/peers/${hubPeerId}`,
      stripRequestHeaders: [PEER_ID_HEADER],
      ...(init.fetchImpl != null ? { fetchImpl: init.fetchImpl } : {}),
    });
    const response = await forward(request);

    // Rule 5: an unreachable upstream, or an opaquely redirecting one (see
    // `urlUpstream`'s own comment on why the latter cannot happen from Node's
    // fetch under `redirect: "manual"`, kept here anyway for the case it
    // does) — kept as distinct `kind`s, and never naming the upstream itself.
    const marker = response.headers.get(MARKER);
    if (marker != null) {
      const kind = marker === "upstream-redirect" ? "upstream-redirect" : "upstream-unreachable";
      return Response.json({ error: MARKER_ERROR_TEXT[kind], kind }, { status: 502 });
    }

    const headers = new Headers(response.headers);
    const location = headers.get("location");
    if (location != null) headers.set("location", rewriteLocation(location, origins));

    // See the module comment: undici decompresses the body but leaves these
    // headers describing the ENCODED form, which no longer matches what
    // `response.text()`/`response.body` actually yield.
    if (headers.has("content-encoding")) {
      headers.delete("content-encoding");
      headers.delete("content-length");
    }

    const path = new URL(request.url).pathname;
    if (shouldRewriteBody(path, headers.get("content-type"))) {
      const text = await response.text();
      const rewritten = stripOrigins(text, origins);
      headers.delete("content-length");
      return new Response(rewritten, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // Every other body streams untouched.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
