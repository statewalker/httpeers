/**
 * Origin-agnostic rewriting for the LiteLLM passthrough — spec §5.2 rules 3-4,
 * measured in `docs/research/2026-09-15-llm-appliance-spikes/litellm-ui-through-mesh.md`
 * ("Follow-up: origin-agnostic rewriting").
 *
 * LiteLLM is told `PROXY_BASE_URL=http://llm.mesh.invalid` (a sentinel, never
 * a real origin) so its own absolute-URL construction (`get_custom_url()`)
 * never bakes in one caller's origin. Two more places still leak an absolute
 * URL regardless of that setting: Starlette's `StaticFiles` trailing-slash
 * redirect (uses LiteLLM's raw bind address, ignoring `PROXY_BASE_URL`
 * entirely) and the sentinel itself, echoed back in exactly two JSON bodies.
 * Both are fixed the same way: strip a known-origin prefix, root-relative or
 * empty is what is left.
 */

/**
 * A `Location` value at one of `origins` becomes root-relative; the empty
 * remainder is `/`. The match is CASE-INSENSITIVE (scheme and host are, per
 * RFC 3986) and requires a real origin boundary after the prefix — `/`, `?`,
 * `#` or end of string — so `http://litellm:4000` does not falsely match
 * `http://litellm:40001/x` (a different host that merely starts with the same
 * digits).
 */
export function rewriteLocation(value: string, origins: readonly string[]): string {
  const lowerValue = value.toLowerCase();
  for (const origin of origins) {
    const lowerOrigin = origin.toLowerCase();
    if (!lowerValue.startsWith(lowerOrigin)) continue;
    const boundary = value.charAt(origin.length);
    if (boundary === "" || boundary === "/" || boundary === "?" || boundary === "#") {
      const rest = value.slice(origin.length);
      return rest === "" ? "/" : rest;
    }
  }
  return value;
}

/**
 * Exactly the two endpoints measurement found need it (spec §5.2 rule 4):
 * `/v2/login`'s `redirect_url` and `/.well-known/litellm-ui-config`'s
 * `proxy_base_url`, and only when the response actually is JSON — a
 * `content-type` with parameters (`application/json; charset=utf-8`) still
 * counts.
 */
export function shouldRewriteBody(path: string, contentType: string | null): boolean {
  if (contentType == null) return false;
  const bare = contentType.split(";")[0]?.trim().toLowerCase();
  if (bare !== "application/json") return false;
  return path.endsWith("/v2/login") || path.endsWith("/.well-known/litellm-ui-config");
}

/**
 * Plain text substitution of every `origins` string with `""`, across a whole
 * body. Safe here because in the two gated bodies the only occurrences of
 * these origin strings are inside URL-valued fields — see the spike's
 * measurement for why nothing else could collide.
 */
export function stripOrigins(text: string, origins: readonly string[]): string {
  let result = text;
  for (const origin of origins) result = result.split(origin).join("");
  return result;
}
