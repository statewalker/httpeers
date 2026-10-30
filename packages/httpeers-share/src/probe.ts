/**
 * "Test again": one request through the same Upstream Guests use.
 */

import type { Upstream } from "@statewalker/webrun-http-proxy";
import {
  BRIDGE_COOKIES_KEPT_HEADER,
  BRIDGE_GUEST_HEADER,
  BRIDGE_SET_COOKIE_HEADER,
  PROBE_GUEST,
  unreachable,
} from "./upstreams.js";

export type Health = "ok" | "slow" | "down";
export type ProbeCause = "service-down" | "bridge-down" | "cors-missing";
export type ProbeWarning = "ws-needed" | "cookies-set";

export interface ProbeReport {
  health: Health;
  cause?: ProbeCause;
  warnings: ProbeWarning[];
  ms: number;
}

/** What Guests notice: a page that takes longer than this feels broken. */
export const SLOW_MS = 1500;

export async function probe(
  upstream: Upstream,
  opts: { slowMs?: number; direct?: string } = {},
): Promise<ProbeReport> {
  const started = performance.now();
  // As a Guest of its own: a Bridge with cookie jars treats the Probe like anyone else.
  const response = await upstream(
    new Request("http://probe.peershare/", { headers: { [BRIDGE_GUEST_HEADER]: PROBE_GUEST } }),
  );
  const body = await response.text();
  const ms = Math.round(performance.now() - started);

  const down = unreachable(response);
  if (down === "service" && opts.direct != null && (await answersWithoutCors(opts.direct))) {
    return { health: "down", cause: "cors-missing", warnings: [], ms };
  }
  if (down != null) return { health: "down", cause: `${down}-down`, warnings: [], ms };
  // A 404 at `/` is an app that answers; a 5xx is one that does not work.
  if (response.status >= 500) return { health: "down", cause: "service-down", warnings: [], ms };

  const health = ms >= (opts.slowMs ?? SLOW_MS) ? "slow" : "ok";
  const warnings: ProbeWarning[] = [];
  if (isHtml(response) && WEBSOCKET_CLIENTS.some((re) => re.test(body))) warnings.push("ws-needed");
  // Only the Bridge's marker: a page never sees `Set-Cookie` itself.
  // A cookie login breaks for Guests only when nothing keeps the cookies for them.
  const kept = response.headers.get(BRIDGE_COOKIES_KEPT_HEADER) === "kept";
  if (response.headers.has(BRIDGE_SET_COOKIE_HEADER) && !kept) warnings.push("cookies-set");
  return { health, warnings, ms };
}

/**
 * Pages whose scripts open a WebSocket: dev servers' hot-reload clients, and
 * pages that do it themselves. Guests' traffic is HTTP only, so these break.
 * Matched in script tags and code, not in prose.
 */
const WEBSOCKET_CLIENTS = [
  /<script[^>]+src="[^"]*\/@vite\/client"/,
  /<script[^>]+src="[^"]*webpack-dev-server/,
  /<script[^>]+src="[^"]*\/_next\/webpack-hmr/,
  /new\s+WebSocket\s*\(/,
];

function isHtml(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/html");
}

/**
 * In a browser a missing CORS header fails exactly like a dead server. A
 * `no-cors` request is not subject to CORS: an (opaque) answer means the
 * site is up, so what is missing is its permission for other origins.
 */
async function answersWithoutCors(target: string): Promise<boolean> {
  try {
    await fetch(target, { mode: "no-cors" });
    return true;
  } catch {
    return false;
  }
}
