/**
 * One stored proxy route as a live upstream, carrying whatever credential was
 * typed this session.
 *
 * Its own module so the header hygiene -- what reaches an OUTSIDE origin --
 * can be tested without a browser page around it (`tests/proxy-upstream.test.ts`).
 */

import { bodyOf, MESH_CREDENTIAL_HEADERS } from "@statewalker/httpeers-core";
import { type Upstream, urlUpstream } from "@statewalker/webrun-http-proxy";
import type { StoredRoute } from "./route-store.js";

/**
 * Rebuild `request` at `url` -- the proxy page's own rewrite, before handing
 * the result to an `Upstream`.
 *
 * Used to be `new Request(url, request)`, the init-from-`Request` form,
 * which reads `body` off the init object. FIREFOX HAS NO
 * `Request.prototype.body` (checked against 155), so that read is
 * `undefined` there and the rewritten request lost its body entirely,
 * silently -- the same defect already fixed in `edge-dispatch.ts`,
 * `gateway.ts`, `router.ts` and the ghost's `pin.ts`. Rebuilt through
 * `bodyOf`, the one copy of this logic, same as the rest.
 */
export async function rewriteForUpstream(request: Request, url: string): Promise<Request> {
  const body = await bodyOf(request);
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    signal: request.signal,
  });
}

export function proxyUpstream(
  route: StoredRoute,
  secret: { name: string; value: string } | undefined,
  fetchImpl?: typeof fetch,
): Upstream {
  return urlUpstream({
    base: route.upstream,
    // Read at REQUEST time, so typing a credential takes effect on the next
    // call rather than needing anything rebuilt.
    credential: () => (secret == null ? {} : { [secret.name]: secret.value }),
    // THE ONE THING THE PROXY USED TO KNOW ABOUT MESHES. A third-party origin
    // has no business seeing a visitor's membership token or learning which
    // peer called; both travel as headers, and the proxy forwards everything
    // it is not told to strip -- `authorization` included, which is the
    // application's.
    stripRequestHeaders: MESH_CREDENTIAL_HEADERS,
    ...(fetchImpl != null ? { fetchImpl } : {}),
  });
}
