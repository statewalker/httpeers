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
 * HEADERS (rule 2). `urlUpstream` already drops `authorization` and
 * hop-by-hop headers; `stripRequestHeaders: [PEER_ID_HEADER]` drops the
 * proven-peer header too. No `headers` or `credential` is configured here, so
 * the master key is never added — it belongs to `keys.ts` alone.
 *
 * REDIRECTS AND BODIES (rules 3-4) are `rewrite.ts`'s job; this file only
 * decides WHEN to buffer (the two gated endpoints) versus stream (everything
 * else, including SSE).
 *
 * ERRORS (rule 5). `urlUpstream` reports an unreachable upstream as a 502 with
 * its own `MARKER` header and a plain-text body; this rewraps that into the
 * spec's `{ error, kind: "upstream-unreachable" }` JSON shape.
 */

import { PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { MARKER, urlUpstream } from "@statewalker/webrun-http-proxy";
import { rewriteLocation, shouldRewriteBody, stripOrigins } from "./rewrite.js";

export const SENTINEL_ORIGINS = ["http://llm.mesh.invalid", "https://llm.mesh.invalid"] as const;

export interface PassthroughInit {
  /** `HUB_LLM_UPSTREAM`, e.g. `http://litellm:4000`. */
  upstream: string;
}

export type Passthrough = (request: Request, hubPeerId: string) => Promise<Response>;

/** Build the passthrough handler — see the module comment for the rules it implements. */
export function createPassthrough(init: PassthroughInit): Passthrough {
  const upstreamOrigin = new URL(init.upstream).origin;
  const origins: readonly string[] = [upstreamOrigin, ...SENTINEL_ORIGINS];

  return async (request, hubPeerId) => {
    const forward = urlUpstream({
      base: `${init.upstream}/peers/${hubPeerId}`,
      stripRequestHeaders: [PEER_ID_HEADER],
    });
    const response = await forward(request);

    // Rule 5: an unreachable (or opaquely redirecting) upstream — see
    // `urlUpstream`'s own comment on why the latter cannot happen from Node's
    // fetch under `redirect: "manual"`, kept here anyway for the case it does.
    if (response.headers.has(MARKER)) {
      return Response.json(
        { error: `llm: upstream ${init.upstream} unreachable`, kind: "upstream-unreachable" },
        { status: 502 },
      );
    }

    const headers = new Headers(response.headers);
    const location = headers.get("location");
    if (location != null) headers.set("location", rewriteLocation(location, origins));

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
