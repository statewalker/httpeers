/**
 * `POST /llm/keys` — spec §5.2. The hub itself calls LiteLLM's
 * `POST /key/generate` with the master key; the caller never sees or supplies
 * it. Only the allowed fields are forwarded, so a caller cannot smuggle
 * through anything `key/generate` accepts that this route does not mean to
 * expose (e.g. a field that widens the key's own scope beyond what was asked).
 *
 * THE MASTER KEY GOES IN `x-litellm-api-key`, NOT `Authorization`. The
 * appliance's `general_settings.litellm_key_header_name: x-litellm-api-key`
 * (global-constraints.md) retargets LiteLLM's OWN key extraction to that
 * header — MEASURED (spike's Q3) to mean `Authorization` is then ignored for
 * this purpose entirely. Sending the master key as `Authorization` would 401
 * against real LiteLLM. The header's VALUE keeps the `Bearer ` prefix; only
 * the header NAME moves.
 *
 * NO REDIRECT IS EVER FOLLOWED (`redirect: "manual"`). Re-issuing a POST with
 * the master key still attached to wherever a 3xx pointed would hand it to a
 * host this call never meant to trust; a redirect is reported as a failure of
 * this call instead (`kind: "upstream-error"`).
 */

const ALLOWED_FIELDS = [
  "key_alias",
  "user_id",
  "models",
  "max_budget",
  "budget_duration",
  "duration",
  "tpm_limit",
  "rpm_limit",
  "metadata",
] as const;

export interface KeysInit {
  /** `HUB_LLM_UPSTREAM`, e.g. `http://litellm:4000`. Expected already normalized (no trailing slash) — `llmModule` does that once. */
  upstream: string;
  /** `LITELLM_MASTER_KEY`. Never forwarded to a caller, never on a passthrough request. */
  masterKey: string;
  /** Injected by tests; defaults to the platform's. */
  fetchImpl?: typeof fetch;
}

export type KeysHandler = (request: Request, hubPeerId: string) => Promise<Response>;

function errorResponse(status: number, error: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error, ...extra }, { status });
}

/** Build the `/llm/keys` handler — see the module comment. */
export function createKeys(init: KeysInit): KeysHandler {
  const doFetch = init.fetchImpl ?? globalThis.fetch;

  return async (request, hubPeerId) => {
    if (request.method !== "POST") {
      return errorResponse(405, "llm: /keys accepts POST only");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "llm: /keys expects a JSON body");
    }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(400, "llm: /keys expects a JSON object");
    }

    const forwarded: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (field in (body as Record<string, unknown>)) {
        forwarded[field] = (body as Record<string, unknown>)[field];
      }
    }

    const target = `${init.upstream}/peers/${hubPeerId}/llm/key/generate`;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await doFetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // See the module comment: the header LiteLLM actually reads, not
          // Authorization.
          "x-litellm-api-key": `Bearer ${init.masterKey}`,
        },
        body: JSON.stringify(forwarded),
        signal: request.signal,
        redirect: "manual",
      });
    } catch {
      // No `detail`: the error text names the internal upstream address.
      return errorResponse(502, "llm: key/generate upstream unreachable", {
        kind: "upstream-error",
      });
    }

    // A redirect is never followed — see the module comment. Node's fetch
    // under `redirect: "manual"` returns the real 3xx status rather than an
    // opaque one; the `type` check is kept for a fetch implementation that
    // does report it that way (e.g. a browser's).
    if (
      upstreamResponse.type === "opaqueredirect" ||
      (upstreamResponse.status >= 300 && upstreamResponse.status < 400)
    ) {
      return errorResponse(502, "llm: key/generate redirected unexpectedly", {
        kind: "upstream-error",
      });
    }

    let payload: unknown;
    try {
      payload = await upstreamResponse.json();
    } catch {
      payload = undefined;
    }

    if (!upstreamResponse.ok) {
      return errorResponse(upstreamResponse.status, "llm: key/generate failed", {
        kind: "upstream-error",
        detail: payload ?? null,
      });
    }

    const data = (payload ?? {}) as Record<string, unknown>;
    if (typeof data.key !== "string") {
      return errorResponse(502, "llm: key/generate returned no key", { kind: "upstream-error" });
    }
    return Response.json({
      key: data.key,
      key_alias: data.key_alias,
      expires: data.expires ?? null,
    });
  };
}
