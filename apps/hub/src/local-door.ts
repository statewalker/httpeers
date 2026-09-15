/**
 * The local door: the hub's own HTTP server, for the local operator.
 *
 * NEVER THROUGH `withAccess`. A request here has no transport-proven peer, so
 * the access layer would refuse it 401 before any policy ran. The door calls
 * the service modules and the admin API directly; its gate is the reverse
 * proxy in front of it -- basic auth on `127.0.0.1:8080` -- and the three
 * checks below, which make that proxy the ONLY client the door answers.
 *
 * NOT PUBLISHING THE PORT IS NOT ENOUGH (measured): a Linux host routes to a
 * container's bridge IP, so any local process reached the door directly, and
 * a browser page could through DNS rebinding. So, on EVERY route (the static
 * UI and `/peers/*` included), in this order:
 *
 *   1. `x-hub-door-secret` must equal the configured secret (constant-time),
 *      or 401. The proxy sets it, overwriting whatever a client sent; nothing
 *      else knows it. It is stripped before a module sees the request.
 *   2. `Host` must be one of `allowedHosts` (what a browser uses to reach the
 *      proxy, which passes Host through), or 421. A DNS-rebound page carries
 *      its own domain as Host.
 *   3. A request that is not GET/HEAD and carries `Origin` must come from
 *      `http://<allowed host>`, or 403 -- a cross-site form post cannot ride
 *      the browser's cached basic-auth credentials.
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

import { createHash, timingSafeEqual } from "node:crypto";
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

/** The header the reverse proxy sets on every request it forwards to the door. */
export const DOOR_SECRET_HEADER = "x-hub-door-secret";

export interface LocalDoorInit {
  hubPeerId: string;
  /** `HUB_DOOR_SECRET`. Required: an empty secret is refused at construction. */
  secret: string;
  /** `HUB_DOOR_ALLOWED_HOSTS`, `host:port` each. Required and non-empty. */
  allowedHosts: string[];
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

/** `host[:port]` as a URL would print it (lowercase, default port dropped); `undefined` if it is not one. */
function normalizeHost(value: string): string | undefined {
  try {
    const url = new URL(`http://${value}`);
    return url.host !== "" && url.pathname === "/" && url.username === "" ? url.host : undefined;
  } catch {
    return undefined;
  }
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * The three checks from the module comment; `undefined` when the request may
 * pass. Exported for the unit tests.
 */
export function createDoorGate(
  init: Pick<LocalDoorInit, "secret" | "allowedHosts">,
): (request: Request) => Response | undefined {
  if (typeof init.secret !== "string" || init.secret === "") {
    throw new Error("local door: a door secret is required (HUB_DOOR_SECRET)");
  }
  const hosts = new Set<string>();
  for (const entry of init.allowedHosts) {
    const host = normalizeHost(entry.trim());
    if (host == null) throw new Error(`local door: "${entry}" is not a host:port`);
    hosts.add(host);
  }
  if (hosts.size === 0) {
    throw new Error("local door: at least one allowed host is required (HUB_DOOR_ALLOWED_HOSTS)");
  }
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  // Comparing fixed-length digests keeps the comparison constant-time without
  // leaking the secret's length through an early length mismatch.
  const expected = digest(init.secret);

  return (request) => {
    const presented = request.headers.get(DOOR_SECRET_HEADER);
    if (presented == null || !timingSafeEqual(digest(presented), expected)) {
      return Response.json({ error: "local door: unauthorized" }, { status: 401 });
    }

    // Both the Host header and the URL's authority: an absolute-form request
    // line (`GET http://allowed/ HTTP/1.1`) builds the URL from itself, not
    // from Host, so checking only one would let the other through.
    const header = request.headers.get("host");
    const urlHost = new URL(request.url).host;
    const candidates = header != null ? [header, urlHost] : [urlHost];
    if (!candidates.every((value) => hosts.has(normalizeHost(value) ?? ""))) {
      return Response.json({ error: "local door: host not allowed" }, { status: 421 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (origin != null && !origins.has(origin.toLowerCase())) {
        return Response.json(
          { error: "local door: cross-origin request refused" },
          { status: 403 },
        );
      }
    }
    return undefined;
  };
}

/** The door's routing, as a plain handler: what `startLocalDoor` serves. */
export function createLocalDoorHandler(init: LocalDoorInit): Handler {
  const gate = createDoorGate(init);
  const modules = new Map(init.modules.map((m) => [m.id, m]));
  const peerPrefix = `/peers/${init.hubPeerId}/`;

  return async (request) => {
    const refused = gate(request);
    if (refused != null) return refused;

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
      // The door secret is the door's alone: never handed on to a module or its upstream.
      const headers = new Headers(request.headers);
      headers.delete(PEER_ID_HEADER);
      headers.delete(DOOR_SECRET_HEADER);
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
  // Throws before binding anything when the secret or the host list is missing.
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
