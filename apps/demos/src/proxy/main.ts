/**
 * The proxy page: expose an outside origin to the mesh.
 *
 * ISO-FUNCTIONAL with the sandbox's `pages/proxy/main.ts`.
 *
 * ROUTING IS A PLAIN HONO ROUTER. `@statewalker/webrun-http-proxy` used to
 * ship a route table as well, and it turned out to be the uninteresting half:
 * prefix matching, path rewriting and a listing are what a router does, and
 * every caller already has one. The package keeps the part that is genuinely
 * its own -- `urlUpstream`, which re-issues a request to an outside origin
 * with the caller's credential consumed, identity headers stripped, hop-by-hop
 * headers dropped and the body streamed.
 *
 * THE ROUTER IS REBUILT WHEN THE TABLE CHANGES, which is the shape a router
 * wants; the old table took a thunk and re-read it per request. Both solve the
 * same problem -- this page edits routes and types credentials WHILE traffic
 * flows -- and rebuilding is the one a reader of Hono already understands.
 * Credentials are still read per REQUEST, inside `urlUpstream`, so typing one
 * takes effect without rebuilding anything.
 *
 * SECRETS ARE NEVER PERSISTED. A route's credential NAME is configuration and
 * is saved; its VALUE lives in memory for this session only. `StoredRoute` has
 * no field a value fits in and `assertNoSecrets` throws rather than dropping
 * one quietly — a silent drop means a route that worked before a reload and
 * 401s after it.
 */

import { createMounts, PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { type JoinWidget, mountJoinWidget } from "@statewalker/httpeers-join";
import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";
import { MARKER, type Upstream, urlUpstream } from "@statewalker/webrun-http-proxy";
import { Hono } from "hono";
import { EDGE_KEY, meshRules } from "../shared/policy.js";
import { needsPermissiveGater, readRelayAddrs } from "../shared/relay.js";
import { localStorageRouteStore, type StoredRoute } from "../shared/route-store.js";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found == null) throw new Error(`proxy page: no #${id} in the markup`);
  return found;
};

const store = localStorageRouteStore();

/** The current router. Rebuilt when the table changes — see the module comment. */
let router: (request: Request) => Promise<Response> = async () =>
  new Response("no routes yet", { status: 503 });
/** Credential VALUES for this session, by prefix. Never written anywhere. */
const secrets = new Map<string, { name: string; value: string }>();

let session: PeerSession | undefined;
/** Paste or scan an invitation, see the link, disconnect or leave. Mounted once the session exists. */
let joinWidget: JoinWidget | undefined;

/** One stored route as a live upstream, carrying whatever secret was typed this session. */
function upstreamFor(route: StoredRoute): Upstream {
  const secret = secrets.get(route.prefix);
  return urlUpstream({
    base: route.upstream,
    // Read at REQUEST time, so typing a credential takes effect on the next
    // call rather than needing anything rebuilt.
    credential: () => (secret == null ? {} : { [secret.name]: secret.value }),
    // THE ONE THING THE PROXY USED TO KNOW ABOUT MESHES. A third-party origin
    // has no business learning which peer called, and the header travels by
    // default now that proven identity is a header.
    stripRequestHeaders: [PEER_ID_HEADER],
  });
}

/**
 * The route table as a Hono app.
 *
 * `:rest{.*}` captures the remainder and Hono matches on SEGMENT boundaries,
 * so `/open` does not swallow `/openai` -- which the table this replaced had
 * to implement by hand.
 */
function buildRouter(stored: readonly StoredRoute[]): (request: Request) => Promise<Response> {
  const app = new Hono();

  // The listing: prefixes and descriptions, never headers -- a header value
  // may be a credential.
  app.get("/", (c) =>
    c.json({ routes: stored.map((r) => ({ prefix: r.prefix, upstream: r.describe })) }),
  );

  for (const route of stored) {
    const upstream = upstreamFor(route);
    const forward = (c: { req: { url: string; raw: Request } }): Promise<Response> => {
      const url = new URL(c.req.url);
      const rest = url.pathname.slice(route.prefix.length) || "/";
      return upstream(new Request(`http://upstream${rest}${url.search}`, c.req.raw));
    };
    app.all(`${route.prefix}/:rest{.*}`, forward);
    app.all(route.prefix, forward);
  }

  app.notFound(() => new Response("no route", { status: 404, headers: { [MARKER]: "no-route" } }));
  return async (request) => app.fetch(request);
}

async function reloadRoutes(): Promise<void> {
  // `undefined` means NEVER WRITTEN, which is not the same as `[]`: a first
  // visit may seed defaults, a visit after the operator deleted every route
  // must not bring them back.
  const stored = (await store.load()) ?? [];
  router = buildRouter(stored);
  renderRoutes(stored);
}

function renderRoutes(stored: StoredRoute[]): void {
  if (stored.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "no routes yet";
    tr.append(td);
    el("routes").replaceChildren(tr);
    return;
  }

  el("routes").replaceChildren(
    ...stored.map((route) => {
      const tr = document.createElement("tr");
      const prefix = document.createElement("td");
      prefix.className = "mono";
      prefix.textContent = route.prefix;
      const base = document.createElement("td");
      base.className = "mono";
      base.textContent = route.upstream;

      const credential = document.createElement("td");
      const secret = secrets.get(route.prefix);
      credential.textContent =
        route.secretHeader == null
          ? "—"
          : secret == null
            ? `${route.secretHeader} (re-enter after reload)`
            : `${route.secretHeader} ✓`;

      const actions = document.createElement("td");
      const remove = document.createElement("button");
      remove.textContent = "remove";
      remove.addEventListener("click", () => {
        void (async () => {
          const kept = ((await store.load()) ?? []).filter((r) => r.prefix !== route.prefix);
          await store.save(kept);
          secrets.delete(route.prefix);
          await reloadRoutes();
        })();
      });
      actions.append(remove);

      tr.append(prefix, base, credential, actions);
      return tr;
    }),
  );
}

async function addRoute(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const prefix = el<HTMLInputElement>("route-prefix").value.trim();
  const base = el<HTMLInputElement>("route-upstream").value.trim();
  const secretName = el<HTMLInputElement>("route-secret-name").value.trim();
  const secretValue = el<HTMLInputElement>("route-secret-value").value;

  if (prefix === "" || base === "") return;

  try {
    const stored = (await store.load()) ?? [];
    const next: StoredRoute = {
      prefix,
      describe: prefix,
      upstream: base,
      secretHeader: secretName === "" ? null : secretName,
    };
    // `save` THROWS if a value ever reached a stored route, rather than
    // dropping it. That is the point: a silent drop is a route that worked
    // before the reload and 401s after.
    await store.save([...stored.filter((r) => r.prefix !== prefix), next]);

    if (secretName !== "" && secretValue !== "") {
      secrets.set(prefix, { name: secretName, value: secretValue });
    }
    el<HTMLInputElement>("route-secret-value").value = "";
    el("route-status").textContent = `added ${prefix}`;
    await reloadRoutes();
  } catch (err) {
    el("route-status").textContent = String(err);
  }
}

/**
 * Try a route, IN PROCESS — not through the mesh, and that is the correct
 * shape rather than a shortcut.
 *
 * Calling our own `/proxy` mount through our own edge looks tidier and is
 * refused, with a 401 whose reason is `peer-binding`. The refusal is right:
 * a membership token is bound to the connection that PROVED its subject, the
 * edge strips the proven-peer header because a local request crossed no wire,
 * and a token whose subject matches nobody is exactly the confused-deputy
 * shape the binding check exists to catch. Nothing is broken — the demo was
 * asking the wrong question.
 *
 * What an operator wants here is "does my route reach the upstream", which is
 * a local question. Other peers reach this table over the mesh, where their
 * own connection proves who they are and the same check passes.
 */
async function sendConsole(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const path = el<HTMLInputElement>("console-path").value.trim();
  if (path === "") return;

  el("console-status").textContent = "sending…";
  try {
    const target = `http://proxy.local${path.startsWith("/") ? path : `/${path}`}`;
    const res = await router(
      new Request(target, { method: el<HTMLSelectElement>("console-method").value }),
    );
    const body = await res.text();
    el("console-output").hidden = false;
    el("console-output").textContent = `${res.status} ${res.statusText}\n\n${body.slice(0, 4000)}`;
    el("console-status").textContent = "";
  } catch (err) {
    el("console-status").textContent = String(err);
  }
}

function render(state: SessionState): void {
  el("state").textContent = state.phase.kind;
  el("peer-id").textContent = state.identity ?? "…";

  // The join form, the phase and its message, and the session controls.
  joinWidget?.update(state);
}

async function main(): Promise<void> {
  await reloadRoutes();
  const relayAddrs = await readRelayAddrs();

  const mounts = createMounts();
  // The mount delegates to whatever router is current, so editing the table
  // takes effect without re-mounting anything.
  mounts.provide("/proxy", (request) => router(request));

  session = createSession({
    key: EDGE_KEY,
    mounts,
    rules: meshRules(),
    advertisements: () => [{ id: "proxy", kind: "proxy", title: "Proxy" }],
    dev: needsPermissiveGater(relayAddrs),
    serviceWorkerUrl: "/sw.js",
    onChange: render,
    readDeploymentConfig: async () => null,
  });

  joinWidget = mountJoinWidget(el("mesh-join"), { session, state: session.state() });
  el<HTMLFormElement>("add-route-form").addEventListener("submit", (e) => void addRoute(e));
  el<HTMLFormElement>("console-form").addEventListener("submit", (e) => void sendConsole(e));

  await session.start();
}

main().catch((err: unknown) => {
  el("state").textContent = "error";
  el("error").hidden = false;
  el("error").textContent =
    `${String(err)}\n\nIf this keeps happening, reset this app from the link below.`;
});
