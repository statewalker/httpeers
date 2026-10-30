/**
 * Upstream kinds: how the Sharer's tab reaches a Service's local URL.
 */

import { MESH_CREDENTIAL_HEADERS } from "@statewalker/httpeers-core";
import { MARKER, type Upstream, urlUpstream } from "@statewalker/webrun-http-proxy";

/** Which local URL the Bridge relays to. Set by the Sharer, never by a Guest. */
export const BRIDGE_TARGET_HEADER = "x-peershare-target";
/** The Pairing token the Bridge printed at launch. */
export const BRIDGE_TOKEN_HEADER = "x-peershare-bridge-token";
/** Marks the Bridge's own responses, so they are never mistaken for the Service's. */
export const BRIDGE_MARKER = "x-peershare-bridge";
/**
 * A Service's redirect, restated by the Bridge as a 200 with these two
 * headers: a browser makes every `redirect: "manual"` 3xx opaque (status 0,
 * no `Location`), so a real 3xx would reach the page with nothing in it.
 */
export const BRIDGE_REDIRECT_STATUS_HEADER = "x-peershare-redirect-status";
export const BRIDGE_REDIRECT_LOCATION_HEADER = "x-peershare-redirect-location";
/**
 * How many cookies the Service tried to set. `Set-Cookie` is a forbidden
 * response header: no page script can read it, so the Bridge says it instead.
 */
export const BRIDGE_SET_COOKIE_HEADER = "x-peershare-set-cookie";
/**
 * Which Guest a request is for, as the Sharer states it from the mesh-proven
 * peer id (rung 16); a Guest's own copy is overwritten. The Bridge keeps one
 * cookie jar per value.
 */
export const BRIDGE_GUEST_HEADER = "x-peershare-guest";
/** Set by a Bridge with cookie jars when it kept the Service's cookies for that Guest. */
export const BRIDGE_COOKIES_KEPT_HEADER = "x-peershare-cookies";
/** The Guest id the Probe uses, so a Bridge with cookie jars treats it like any Guest. */
export const PROBE_GUEST = "peershare-probe";

export type UpstreamConfig =
  | { kind: "direct"; target: string }
  | { kind: "bridged"; target: string; bridge: { base: string; token: string } };

export function createUpstream(config: UpstreamConfig): Upstream {
  // A Guest's membership token and peer id are consumed by the mesh hop:
  // Dirk's app has no business seeing them, whichever way it is reached.
  // A Guest's copy of the Bridge headers goes too: the target and token are
  // the Sharer's to set, and Direct would otherwise hand them to the app.
  const stripRequestHeaders = [
    ...MESH_CREDENTIAL_HEADERS,
    BRIDGE_TARGET_HEADER,
    BRIDGE_TOKEN_HEADER,
  ];
  if (config.kind === "direct") {
    return inGuestOrigin(
      urlUpstream({
        base: config.target,
        stripRequestHeaders,
        fetchImpl: directFetch(needsLocalAddressSpace(config.target)),
      }),
      config.target,
    );
  }
  // Bridged is a URL upstream too: re-issued at the Bridge instead of the
  // Service, with the real target and the Pairing token as headers.
  const viaBridge = urlUpstream({
    base: config.bridge.base,
    stripRequestHeaders,
    headers: {
      [BRIDGE_TARGET_HEADER]: config.target,
      [BRIDGE_TOKEN_HEADER]: config.bridge.token,
    },
  });
  return inGuestOrigin(async (request) => {
    const response = await viaBridge(request);
    const redirect = response.headers.get(BRIDGE_REDIRECT_STATUS_HEADER);
    if (redirect != null) {
      // Back to a real redirect for the Guest (see BRIDGE_REDIRECT_STATUS_HEADER).
      const headers = new Headers(response.headers);
      headers.set("location", headers.get(BRIDGE_REDIRECT_LOCATION_HEADER) ?? "/");
      headers.delete(BRIDGE_REDIRECT_STATUS_HEADER);
      headers.delete(BRIDGE_REDIRECT_LOCATION_HEADER);
      return new Response(null, { status: Number(redirect), headers });
    }
    // To `urlUpstream` the Bridge IS the upstream, so its "unreachable" means
    // the Bridge is not running, not that the Service is down.
    if (response.headers.get(MARKER) !== "upstream-unreachable") return response;
    const headers = new Headers(response.headers);
    headers.delete(MARKER);
    headers.set(BRIDGE_MARKER, "bridge-unreachable");
    return new Response(response.body, { status: response.status, headers });
  }, config.target);
}

/**
 * A Guest sees the Service at the root of their own isolated origin (rung
 * 08), so a redirect the Service writes absolutely to ITSELF
 * (`https://wiki.example.com/login`, `http://127.0.0.1:5173/login`) must
 * become a path, or the Guest's frame leaves that origin. Redirects anywhere
 * else stay absolute.
 */
function inGuestOrigin(upstream: Upstream, target: string): Upstream {
  const own = new URL(target).origin;
  return async (request) => {
    const response = await upstream(request);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location == null) return response;
    const resolved = new URL(location, target);
    if (resolved.origin !== own) return response;
    const headers = new Headers(response.headers);
    headers.set("location", `${resolved.pathname}${resolved.search}${resolved.hash}`);
    return new Response(response.body, { status: response.status, headers });
  };
}

/** Which hop did not answer, read off an `Upstream`'s response; `undefined` when something did. */
export function unreachable(response: Response): "service" | "bridge" | undefined {
  const bridge = response.headers.get(BRIDGE_MARKER);
  if (bridge === "bridge-unreachable") return "bridge";
  if (bridge === "target-unreachable") return "service";
  if (response.headers.get(MARKER) === "upstream-unreachable") return "service";
  return undefined;
}

/**
 * A plain-http Service on the LAN, called from the https PeerShare page, is
 * mixed content and Chromium blocks it — unless the call says the target is
 * on the local network, which also lets Local Network Access ask the Sharer
 * (measured in rung 03). Loopback needs nothing: it is trusted already.
 */
function needsLocalAddressSpace(target: string): boolean {
  const url = new URL(target);
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host === "::1" || /^127\./.test(host));
}

/**
 * How Direct calls the Service. Redirects are FOLLOWED: in the Sharer's
 * browser tab a `redirect: "manual"` response is opaque (status 0, no
 * `Location`), so following is the only way to serve a site that redirects
 * (rung 04). Same everywhere, so Node and the browser agree.
 * `targetAddressSpace` is Chromium's; other runtimes ignore it.
 */
function directFetch(local: boolean): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      redirect: "follow",
      ...(local ? { targetAddressSpace: "local" } : {}),
    } as RequestInit);
}
