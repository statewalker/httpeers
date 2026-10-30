/**
 * The Bridge: a loopback relay from the PeerShare page to the Sharer's local
 * Services, speaking rung 01's wire contract.
 *
 * A loopback port that answers cross-origin requests is reachable by EVERY
 * website the Sharer visits. Each rule below closes one way in; the tests in
 * `../tests/` name them.
 */

import { timingSafeEqual } from "node:crypto";
import { type FetchHandler, MARKER, urlUpstream } from "@statewalker/webrun-http-proxy";
import { checkTarget, isPrivateAddress } from "../targets.js";
import {
  BRIDGE_COOKIES_KEPT_HEADER,
  BRIDGE_GUEST_HEADER,
  BRIDGE_MARKER,
  BRIDGE_REDIRECT_LOCATION_HEADER,
  BRIDGE_REDIRECT_STATUS_HEADER,
  BRIDGE_SET_COOKIE_HEADER,
  BRIDGE_TARGET_HEADER,
  BRIDGE_TOKEN_HEADER,
} from "../upstreams.js";
import { type SocketGate, socketGate } from "./sockets.js";

export interface BridgeInit {
  /** The Pairing token generated at launch; nothing is answered without it. */
  token: string;
  /** The PeerShare page's origin; the only one granted cross-origin access. */
  allowedOrigin: string;
  /** Injected by tests; defaults to the platform's. */
  fetchImpl?: typeof fetch;
  /** Every address a `.local` name resolves to. Injected by tests; defaults to the OS resolver. */
  resolveHost?: (name: string) => Promise<string[]>;
  /**
   * Keep one cookie jar per Guest (rung 16, spike): a Service's `Set-Cookie`
   * goes into the jar of the Guest named in `x-peershare-guest`, and that
   * jar's cookies go on the Guest's next requests. Cookies never reach the
   * page, which could not use them anyway.
   */
  cookieJars?: boolean;
}

/** Whether the Bridge may relay to `target` (rung 02 rules): `ok`, `forbidden` or `unreachable`. */
export async function reachable(
  target: string,
  resolveHost: (name: string) => Promise<string[]>,
): Promise<"ok" | "forbidden" | "unreachable"> {
  const verdict = checkTarget(target);
  if (verdict === "forbidden") return "forbidden";
  if (verdict === "allowed") return "ok";
  const addresses = await resolveHost(verdict.resolve).catch(() => []);
  if (addresses.length === 0) return "unreachable";
  return addresses.every(isPrivateAddress) ? "ok" : "forbidden";
}

export async function systemResolve(name: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(name, { all: true })).map((a) => a.address);
}

/** The Bridge's HTTP handler, carrying its WebSocket gate for whichever server hosts it. */
export type BridgeHandler = FetchHandler & { sockets: SocketGate };

export function createBridge(init: BridgeInit): BridgeHandler {
  const resolveHost = init.resolveHost ?? systemResolve;
  const jars = new Map<string, Map<string, string>>();
  const handler: FetchHandler = async (incoming) => {
    const guest = init.cookieJars === true ? incoming.headers.get(BRIDGE_GUEST_HEADER) : null;
    const jar =
      guest == null ? undefined : (jars.get(guest) ?? jars.set(guest, new Map()).get(guest));
    const request = jar == null ? incoming : withCookies(incoming, jar);
    // A page on another site carries its own `Origin`. No `Origin` at all is
    // a local process (curl, the Probe's CLI): the token alone admits it.
    const origin = request.headers.get("origin");
    if (origin != null && origin !== init.allowedOrigin) return refuse(403, "origin-forbidden");

    // A preflight never carries custom headers, so it cannot carry the token:
    // the origin check above is all that guards it, and it grants nothing
    // but permission to send the real, token-bearing request.
    if (
      origin != null &&
      request.method === "OPTIONS" &&
      request.headers.has("access-control-request-method")
    ) {
      return preflight(request, origin);
    }
    if (!sameSecret(request.headers.get(BRIDGE_TOKEN_HEADER), init.token)) {
      return refuse(401, "bad-token", origin);
    }
    // No target: the page is asking whether its Bridge is there and its
    // token is right (the token check above already passed).
    const target = request.headers.get(BRIDGE_TARGET_HEADER) || null;
    if (target == null) {
      const headers = new Headers({ "content-type": "application/json" });
      if (origin != null) grantTo(headers, origin);
      return new Response(JSON.stringify({ bridge: "peershare" }), { headers });
    }
    // The page passed both checks, so it may read WHY the target was refused.
    const reach = await reachable(target, resolveHost);
    if (reach !== "ok") return refuse(reach === "forbidden" ? 403 : 502, `target-${reach}`, origin);

    // The same re-issuing the page itself does (rung 01): hop-by-hop headers
    // dropped, body streamed, redirects reported. The Bridge's own headers
    // are consumed by this hop.
    const upstream = urlUpstream({
      base: target,
      stripRequestHeaders: [BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER, BRIDGE_GUEST_HEADER],
      ...(init.fetchImpl != null ? { fetchImpl: init.fetchImpl } : {}),
    });
    const response = await upstream(request);

    // The proxy's own "unreachable" is about the SERVICE here. Passed on as
    // is, the page's upstream (to which the Bridge is the upstream) would
    // read it as "the Bridge is down" — so it is restated in the contract's
    // words, and the proxy's marker removed.
    if (response.headers.get(MARKER) === "upstream-unreachable") {
      return refuse(502, "target-unreachable", origin);
    }

    const headers = new Headers(response.headers);
    headers.set(BRIDGE_MARKER, "relayed");
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers.set(BRIDGE_SET_COOKIE_HEADER, String(cookies.length));
    if (jar != null) {
      for (const cookie of cookies) keep(jar, cookie);
      headers.delete("set-cookie");
      if (cookies.length > 0) headers.set(BRIDGE_COOKIES_KEPT_HEADER, "kept");
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location != null) {
      headers.delete("location");
      headers.set(BRIDGE_REDIRECT_STATUS_HEADER, String(response.status));
      headers.set(BRIDGE_REDIRECT_LOCATION_HEADER, withinService(location, target));
      if (origin != null) grantTo(headers, origin);
      return new Response(null, { status: 200, headers });
    }

    if (origin != null) grantTo(headers, origin);
    return new Response(response.body, { status: response.status, headers });
  };
  return Object.assign(handler, { sockets: socketGate(init, resolveHost) });
}

/**
 * A location on the Service itself, as a path: the Guest sees the Service at
 * the root of their own origin, so `http://127.0.0.1:5173/login` must become
 * `/login`. Anywhere else stays absolute.
 */
function withinService(location: string, target: string): string {
  const resolved = new URL(location, target);
  if (resolved.origin !== new URL(target).origin) return resolved.href;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function preflight(request: Request, origin: string): Response {
  const headers = new Headers({
    "access-control-allow-origin": origin,
    vary: "Origin",
    // Echoed: Guests' requests carry whatever headers the shared app uses.
    "access-control-allow-methods": request.headers.get("access-control-request-method") ?? "GET",
    "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "",
    "access-control-max-age": "600",
  });
  // Chromium's Private Network Access preflight: a public page asking for loopback.
  if (request.headers.get("access-control-request-private-network") === "true") {
    headers.set("access-control-allow-private-network", "true");
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Cross-origin permission for exactly one origin. Whatever the Service itself
 * sends (`*`, credentials) is replaced: the Service's CORS policy was written
 * for its own pages, not for a relay that every website can try to reach.
 */
function grantTo(headers: Headers, origin: string): void {
  for (const name of [...headers.keys()]) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  // Every response header, the marker included, readable by the page.
  headers.set("access-control-expose-headers", [...headers.keys()].join(", "));
}

/**
 * A refusal carries no CORS headers unless `grantTo` is given: a foreign page
 * cannot even read why it was refused.
 */
function refuse(status: number, reason: string, grantToOrigin?: string | null): Response {
  const headers = new Headers({ [BRIDGE_MARKER]: reason });
  if (grantToOrigin != null) grantTo(headers, grantToOrigin);
  return new Response(null, { status, headers });
}

export function sameSecret(given: string | null, expected: string): boolean {
  if (given == null) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `request` with `jar`'s cookies as its `Cookie` header (the page cannot send one itself). */
function withCookies(request: Request, jar: Map<string, string>): Request {
  if (jar.size === 0) return request;
  const headers = new Headers(request.headers);
  headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  // Rebuilt from its parts: the server's own request object (e.g.
  // @hono/node-server's) need not be one the global Request can copy.
  const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    ...(body != null ? { duplex: "half" as const } : {}),
    signal: request.signal,
  });
}

/** A spike's cookie jar: name and value only; `Max-Age=0` deletes. Path, domain and expiry are ignored. */
function keep(jar: Map<string, string>, setCookie: string): void {
  const [pair = "", ...attributes] = setCookie.split(";");
  const at = pair.indexOf("=");
  if (at <= 0) return;
  const name = pair.slice(0, at).trim();
  if (attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) jar.delete(name);
  else jar.set(name, pair.slice(at + 1).trim());
}
