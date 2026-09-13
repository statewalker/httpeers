/**
 * 08 — the mesh as ordinary HTTP.
 *
 * ONE `FetchHandler` that serves every resource in the mesh at
 * `/{peerId}/{servicePath}`, so whatever mounts it — `@hono/node-server`, a
 * ServiceWorker, a relay — never learns that libp2p exists.
 *
 * BUILT ON THE PROVEN EDGE, NOT BESIDE IT. The dispatch a page already uses
 * (`src/browser/edge-dispatch.ts`) does four things that took four separate
 * bugs to discover: strip the mount prefix, attach the membership token at
 * call time, ensure a route before the call rides it, and map a thrown
 * `PeerCallError` onto a status the caller can read. This file does not
 * reimplement any of them — it rewrites the request and hands it to that
 * handler, which is what `MemberHandle.fetch` exposes.
 *
 * WHAT IS NEW HERE, and the only thing that is:
 *
 *   1. `basePath` is a parameter. The ServiceWorker edge is keyed to
 *      `/{key}/` and cannot mount at `/`; a Node server mounts wherever it
 *      likes, including `/`. One handler, three hosts.
 *   2. A listing at `GET {basePath}/`, which enumerates peers and the KINDS
 *      they advertise — never URLs. The mesh view carries no service paths,
 *      so a listing that promised URLs would be inventing them.
 *   3. Dispatch is read per request from the live mesh view, so a peer that
 *      joins after the server started is reachable with no rebuild.
 */

import type { FetchHandler, MeshView } from "@statewalker/httpeers-core";
import { stripPeerBinding } from "@statewalker/httpeers-core";

/** What the gateway needs of a member. `MemberHandle` satisfies it; so does a test double. */
export interface GatewaySource {
  peerId: string;
  /** The proven edge dispatch: `/{key}/{peerId}/{path}` in, mesh call out. */
  fetch: FetchHandler;
  /** Read per request — a peer that joined a second ago must be dispatchable. */
  meshView(): MeshView | null;
}

export interface GatewayInit {
  source: GatewaySource;
  /**
   * The prefix this gateway is mounted at, stripped before dispatch.
   * `""` on a Node server; `"/peers"` behind a ServiceWorker keyed `peers`.
   */
  basePath?: string;
  /** The key the underlying edge dispatch expects as the first segment. */
  edgeKey: string;
}

/** Marks the gateway's own responses so they are never mistaken for a peer's. */
export const GATEWAY_MARKER = "x-httpeers-gateway";

export function createGateway(init: GatewayInit): FetchHandler {
  const base = normaliseBase(init.basePath ?? "");

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (base !== "" && !url.pathname.startsWith(base)) {
      return marked(`not under ${base}`, 404, "outside-mount");
    }
    const rest = url.pathname.slice(base.length) || "/";

    // The listing. Honest about what it knows: peers and advertised kinds,
    // with the view's own version and an `asOf` — never a URL, because the
    // mesh view carries no service paths.
    if ((rest === "/" || rest === "") && request.method === "GET") {
      return listing(init.source);
    }

    // SEGMENTS, NEVER A URL HOST. A peer id is base58 and case-sensitive; a
    // URL host is lower-cased by normalisation and userinfo (`a@b`) silently
    // reassigns it. The path is the only safe place to carry one.
    const [, first = "", ...tail] = rest.split("/");
    if (first === "") return marked("no peer in the path", 404, "no-peer");

    // Hand it to the proven dispatch, spelled the way that handler expects.
    const target = new URL(
      `/${init.edgeKey}/${first}${tail.length > 0 ? `/${tail.join("/")}` : ""}${url.search}`,
      "http://gateway.local",
    );

    // ORDINARY HTTP IN FRONT OF A MEMBER, so the caller is a browser or a
    // curl and any proven-peer header it sent is a claim about somebody else.
    // Strip before the request enters the mesh.
    stripPeerBinding(request);

    const forwarded = new Request(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(request.body != null ? { duplex: "half" as const } : {}),
      // FORWARDED DELIBERATELY. `@hono/node-server` aborts this signal when the
      // client hangs up, and nothing else would stop the libp2p call — the
      // stream would run to completion with nobody to receive it.
      signal: request.signal,
    });

    return await init.source.fetch(forwarded);
  };
}

/** `""` or `/a/b` — never a trailing slash, so `base.length` is a clean cut. */
function normaliseBase(value: string): string {
  if (value === "" || value === "/") return "";
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function listing(source: GatewaySource): Response {
  const view = source.meshView();
  // `null` is a real state — "no view yet" is not "nobody is here" — and a
  // listing that flattened the two would be a lie on every first load.
  if (view == null) {
    return Response.json(
      { ready: false, self: source.peerId, peers: [], offers: [] },
      { headers: { [GATEWAY_MARKER]: "no-view" } },
    );
  }
  return Response.json({
    ready: true,
    self: source.peerId,
    version: view.version,
    asOf: Date.now(),
    peers: view.members.map((m) => ({ peerId: m.peerId, roles: m.roles })),
    // Flat, and independent of `peers`: the hub advertises under its own id
    // and is in no member list.
    offers: view.advertisements.map((a) => ({
      peerId: a.peerId,
      id: a.id,
      kind: a.kind,
      title: a.title,
    })),
  });
}

function marked(message: string, status: number, kind: string): Response {
  return new Response(message, { status, headers: { [GATEWAY_MARKER]: kind } });
}
