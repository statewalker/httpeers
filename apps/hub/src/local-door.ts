/**
 * The local door: the hub's own HTTP server, for the local operator.
 *
 * NEVER THROUGH `withAccess`. A request here has no transport-proven peer, so
 * the access layer would refuse it 401 before any policy ran. The door calls
 * the service modules (and, later, the admin API) directly; its gate is the
 * reverse proxy in front of it -- basic auth on `127.0.0.1:8080` -- and it is
 * never published to the host.
 *
 * ROUTES
 *   - `/peers/<hubPeerId>/<moduleId>/...` -> that module, with `caller: "local"`
 *     and the path rewritten to `/<moduleId>/...`, the shape the mesh mount
 *     hands the same handler. The query string is kept, the body streamed.
 *   - `/hub/api` and `/hub/api/...` -> the admin API, when one is given.
 *   - everything else -> the UI: `init.ui` when given, otherwise the built-in
 *     static server over `dist-ui/` next to this file (Task 6's admin page,
 *     `apps/hub/ui/` built by `build:ui`). 404 when even that has nothing.
 *
 * The hub's own mesh endpoints (`/.well-known`, `/admin`) are NOT served here:
 * they read the caller from its token, and there is none.
 */

import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { PEER_ID_HEADER } from "@statewalker/httpeers-core";
import type { ServiceModule } from "./service-module.js";

type Handler = (request: Request) => Promise<Response>;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * A static file server for one directory, `/` -> `index.html`.
 *
 * THE BOUNDARY CHECK IS THE POINT. `join` alone would happily walk a decoded
 * `../` out of `root`; a literal `..` in the URL is already collapsed by
 * `new URL(...)` before this runs, but a percent-encoded one (`/%2e%2e/…`) is
 * not -- it only becomes ".." after `decodeURIComponent`, which happens here.
 * So the check has to happen after decoding, against the real, `normalize`d
 * filesystem path: it must still start with `root`, or the request is
 * refused exactly like a missing file (404, not 403 -- this never confirms
 * to a caller that a path outside `root` exists).
 */
export function createStaticUiHandler(root: string): Handler {
  const base = normalize(root);
  return async (request) => {
    const { pathname } = new URL(request.url);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return notFound(pathname);
    }
    const target = normalize(join(base, decoded === "/" ? "/index.html" : decoded));
    if (target !== base && !target.startsWith(base + sep)) return notFound(pathname);

    let body: Buffer;
    try {
      body = await readFile(target);
    } catch {
      return notFound(pathname);
    }
    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    return new Response(body, { status: 200, headers: { "content-type": type } });
  };
}

/** `apps/hub/dist-ui`, found relative to THIS file so it is right whether it runs from `src/` (tests) or `dist/` (built). */
const DEFAULT_UI_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), "..", "dist-ui"));
let defaultUiHandler: Handler | undefined;
function builtInUiHandler(): Handler {
  defaultUiHandler ??= createStaticUiHandler(DEFAULT_UI_ROOT);
  return defaultUiHandler;
}

export interface LocalDoorInit {
  hubPeerId: string;
  modules: ServiceModule[];
  /** `/hub/api/*`. */
  adminApi?: Handler;
  /** Everything not routed above: the static UI. */
  ui?: Handler;
}

export interface StartLocalDoorInit extends LocalDoorInit {
  port: number;
  /**
   * Default `0.0.0.0`: on a compose bridge network the door is reached from the
   * proxy's container. A host-networked hub must pass `127.0.0.1`.
   */
  hostname?: string;
}

export interface LocalDoor {
  /** The bound port -- the configured one, or the one picked for port 0. */
  port: number;
  /** The address actually bound, as the server reports it. */
  address: string;
  stop(): Promise<void>;
}

const notFound = (path: string) => Response.json({ error: "not found", path }, { status: 404 });

/** The door's routing, as a plain handler: what `startLocalDoor` serves. */
export function createLocalDoorHandler(init: LocalDoorInit): Handler {
  const modules = new Map(init.modules.map((m) => [m.id, m]));
  const peerPrefix = `/peers/${init.hubPeerId}/`;

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith(peerPrefix)) {
      const rest = path.slice(peerPrefix.length - 1); // keeps the leading "/"
      const moduleId = rest.split("/")[1] ?? "";
      const module = modules.get(moduleId);
      if (module == null) return notFound(path);
      const target = new URL(`${rest}${url.search}`, url.origin);
      const hasBody = request.body != null && request.method !== "GET" && request.method !== "HEAD";
      // A local caller names no proven peer; a header claiming one is a forgery.
      const headers = new Headers(request.headers);
      headers.delete(PEER_ID_HEADER);
      const forwarded = new Request(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        signal: request.signal,
        redirect: "manual",
        // Required by Node's fetch for a streamed body; unknown to the DOM typings.
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);
      return module.handler(forwarded, {
        hubPeerId: init.hubPeerId,
        edgeKey: "peers",
        caller: "local",
      });
    }

    if (path === "/hub/api" || path.startsWith("/hub/api/")) {
      return init.adminApi != null ? init.adminApi(request) : notFound(path);
    }

    return (init.ui ?? builtInUiHandler())(request);
  };
}

export async function startLocalDoor(init: StartLocalDoorInit): Promise<LocalDoor> {
  const handler = createLocalDoorHandler(init);
  const fetch = async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch (error) {
      console.log(
        `local door: ${request.method} ${request.url} failed: ${(error as Error).message}`,
      );
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };

  return new Promise<LocalDoor>((resolve, reject) => {
    const server = serve(
      {
        fetch,
        port: init.port,
        hostname: init.hostname ?? "0.0.0.0",
        // Keep Node's own Request/Response. The adapter's lightweight
        // replacements would leak into every libp2p and httpeers call in this
        // process, which build and inspect the globals.
        overrideGlobalObjects: false,
      },
      (info) => {
        server.off("error", reject);
        resolve({
          port: info.port,
          address: info.address,
          stop: () =>
            new Promise<void>((done) => {
              // Streams (SSE, long completions) would hold `close` open forever.
              if ("closeAllConnections" in server) server.closeAllConnections();
              server.close(() => done());
            }),
        });
      },
    );
    server.once("error", reject);
  });
}
