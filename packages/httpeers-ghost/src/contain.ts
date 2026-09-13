/**
 * The two containment candidates, as code, so the decision can be measured.
 *
 * Rung 06 found the hole and refused to choose a remedy: a root-absolute URL
 * from inside a rendered host page — `/static/app.css` — resolves against the
 * VIEWER's origin, silently, and `<base href>` does not fix it because it
 * governs relative URLs only.
 *
 * Three candidates were named. One ("host apps must use relative URLs only")
 * is not a mechanism — nothing enforces it — so it is not implemented here.
 * The other two are, and the point of the rung is that they are measured
 * against the SAME escape:
 *
 *   A. A path-scoped Content-Security-Policy on the ghost's own responses.
 *   B. A sandboxed iframe with no `allow-same-origin`, giving the document an
 *      opaque origin so the viewer's origin is cross-origin to it.
 *
 * Both are applied by the GHOST, to responses the ghost already controls. That
 * is what makes them viable at all: neither needs cooperation from the host
 * app, and neither needs DNS or TLS, which is what sank the subdomain option.
 */

import type { FetchHandler } from "@statewalker/httpeers-core";

export type Containment = "none" | "csp" | "sandbox";

export interface ContainOptions {
  /** Absolute base URL of the ghost's mount, e.g. `http://localhost:4173/ghost/`. */
  baseUrl: string;
  mode: Containment;
}

/**
 * Wrap a ghost handler so its HTML responses carry the containment policy.
 *
 * Only HTML is wrapped: the policy has to reach the DOCUMENT, because that is
 * what a CSP governs and what an opaque origin applies to.
 */
export function contain(handler: FetchHandler, options: ContainOptions): FetchHandler {
  return async (request: Request): Promise<Response> => {
    const response = await handler(request);
    if (options.mode === "none") return response;

    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) {
      // Under sandbox the document has an OPAQUE origin, so every fetch it
      // makes — including one back through the ghost's own mount — is
      // cross-origin and needs CORS. The ghost is the server here, so it can
      // say yes to itself; without this, containment would also contain the
      // host app's legitimate traffic, which is not containment but breakage.
      if (options.mode === "sandbox") {
        const headers = new Headers(response.headers);
        headers.set("access-control-allow-origin", "*");
        return new Response(response.body, { ...response, headers });
      }
      return response;
    }

    const headers = new Headers(response.headers);
    if (options.mode === "sandbox") headers.set("access-control-allow-origin", "*");
    headers.set("content-security-policy", policyFor(options));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/**
 * The policy.
 *
 * A CSP source expression may carry a PATH, and matching is by path prefix —
 * which is the whole reason option A can work same-origin at all. `'self'`
 * would be useless here: the viewer's origin IS self, so `'self'` permits
 * exactly the escape being closed. The source has to be the ghost's mount,
 * spelled out.
 *
 * `'unsafe-inline'` for scripts is not a weakening of the containment: the
 * host app's page is inline script by nature, and what is being contained is
 * WHERE it can reach, not whether it may run.
 */
export function policyFor({ baseUrl, mode }: ContainOptions): string {
  if (mode === "sandbox") {
    // The opaque origin does the containing; the CSP is belt and braces, and
    // `'unsafe-inline'` is required because an opaque origin has no `'self'`.
    return "default-src 'none'; script-src 'unsafe-inline'; connect-src *; img-src *; style-src 'unsafe-inline'";
  }
  return [
    `default-src ${baseUrl}`,
    `connect-src ${baseUrl}`,
    `img-src ${baseUrl}`,
    `style-src ${baseUrl} 'unsafe-inline'`,
    `script-src ${baseUrl} 'unsafe-inline'`,
    "frame-ancestors 'self'",
  ].join("; ");
}

/** The iframe attributes each mode needs, so the page and the tests agree. */
export function frameSandbox(mode: Containment): string | undefined {
  // `allow-same-origin` is deliberately ABSENT: including it would hand the
  // document the viewer's own origin back, which is the thing being prevented.
  if (mode === "sandbox") return "allow-scripts";
  return undefined;
}
