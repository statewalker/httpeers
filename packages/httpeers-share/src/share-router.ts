/**
 * What the Sharer's member mounts for Guests: `/s/<serviceId>/<path>`.
 *
 * The router knows nothing about upstream kinds: it strips the mount, hands
 * the rest of the path to the Service's `Upstream`, and that is all.
 */

import { bodyOf } from "@statewalker/httpeers-core";
import type { FetchHandler, Upstream } from "@statewalker/webrun-http-proxy";
import { Hono } from "hono";

export interface SharedService {
  id: string;
  upstream: Upstream;
}

export function shareRouter(init: { services: () => readonly SharedService[] }): FetchHandler {
  const app = new Hono();

  app.all("/s/:id/*", async (c) => {
    const id = c.req.param("id");
    // Read per request, so adding or pausing a Service needs no rebuild.
    const service = init.services().find((s) => s.id === id);
    if (service == null) return c.notFound();

    const url = new URL(c.req.url);
    const rest = url.pathname.slice(`/s/${id}`.length) || "/";
    // Through `bodyOf`, not `request.body`: Firefox has no `Request.body`,
    // and a rewritten request silently lost its body there.
    const body = await bodyOf(c.req.raw);
    return service.upstream(
      new Request(new URL(`${rest}${url.search}`, url.origin), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body,
        ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
        signal: c.req.raw.signal,
      }),
    );
  });

  return async (request) => app.fetch(request);
}
