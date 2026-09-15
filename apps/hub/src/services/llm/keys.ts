/**
 * `POST /llm/keys` — spec §5.2. The hub itself calls LiteLLM's
 * `POST /key/generate` with the master key; the caller never sees or supplies
 * it. Only the allowed fields are forwarded, so a caller cannot smuggle
 * through anything `key/generate` accepts that this route does not mean to
 * expose (e.g. a field that widens the key's own scope beyond what was asked).
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
  /** `HUB_LLM_UPSTREAM`, e.g. `http://litellm:4000`. */
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

    const target = `${init.upstream.replace(/\/$/, "")}/peers/${hubPeerId}/llm/key/generate`;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await doFetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${init.masterKey}`,
        },
        body: JSON.stringify(forwarded),
      });
    } catch (error) {
      return errorResponse(502, "llm: key/generate upstream unreachable", {
        kind: "upstream-error",
        detail: (error as Error).message,
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
    return Response.json({
      key: data.key,
      key_alias: data.key_alias,
      expires: data.expires ?? null,
    });
  };
}
