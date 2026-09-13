/**
 * The proxy page: expose an outside origin to the mesh.
 *
 * ISO-FUNCTIONAL with the sandbox's `pages/proxy/main.ts`, and the demo that
 * shows what `@statewalker/webrun-http-proxy` is for. The whole proxy — route
 * table, matching, rewriting, the listing, hop-by-hop hygiene, streaming —
 * came out of httpeers in the extraction and has nothing mesh-specific left in
 * it. What this page adds is the mesh half: the table is mounted at `/proxy`
 * so other peers reach it, and the one header the proxy must not forward is
 * named here rather than known there.
 *
 * `routes` IS A THUNK, AND THAT IS LOAD-BEARING. The endpoint is built ONCE
 * and re-reads the table on every request, because this page edits routes and
 * types credentials WHILE traffic flows. A snapshot taken at construction
 * would serve the old table until something restarted it.
 *
 * SECRETS ARE NEVER PERSISTED. A route's credential NAME is configuration and
 * is saved; its VALUE lives in memory for this session only. `StoredRoute` has
 * no field a value fits in and `assertNoSecrets` throws rather than dropping
 * one quietly — a silent drop means a route that worked before a reload and
 * 401s after it.
 */

import { createMounts, PEER_ID_HEADER } from "@statewalker/httpeers-core";
import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";
import type { Route, StoredRoute } from "@statewalker/webrun-http-proxy";
import { rehydrate, routeTable, urlUpstream } from "@statewalker/webrun-http-proxy";
import { localStorageRouteStore } from "@statewalker/webrun-http-proxy/browser";
import { ensureBiscuit } from "../shared/biscuit.js";
import { EDGE_KEY, meshRules } from "../shared/policy.js";
import { needsPermissiveGater, readRelayAddrs } from "../shared/relay.js";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found == null) throw new Error(`proxy page: no #${id} in the markup`);
  return found;
};

const store = localStorageRouteStore();

/** The live table. Re-read per request by the endpoint — see the module comment. */
let routes: Route[] = [];
/** Credential VALUES for this session, by prefix. Never written anywhere. */
const secrets = new Map<string, { name: string; value: string }>();

let session: PeerSession | undefined;
/** The route table as a handler. Held so the local console can call it without a round trip. */
let endpoint: (request: Request) => Promise<Response> = async () =>
  new Response("no routes yet", { status: 503 });

/**
 * Stored routes plus whatever secrets were typed this session.
 *
 * `rehydrate` is the package's own helper for exactly this: stored routes are
 * inert data, and turning each into a live `Upstream` is the caller's job
 * because only the caller holds the credentials.
 */
function hydrate(stored: readonly StoredRoute[]): Route[] {
  return rehydrate(stored, {
    upstreamFor: (route) => {
      const secret = secrets.get(route.prefix);
      return urlUpstream({
        base: route.upstream,
        // Read at REQUEST time, so typing a credential takes effect on the
        // next call rather than needing the table rebuilt.
        credential: () => (secret == null ? {} : { [secret.name]: secret.value }),
        // THE ONE THING THE PROXY USED TO KNOW ABOUT MESHES. A third-party
        // origin has no business learning which peer called, and the header
        // travels by default now that proven identity is a header.
        stripRequestHeaders: [PEER_ID_HEADER],
      });
    },
  });
}

async function reloadRoutes(): Promise<void> {
  // `undefined` means NEVER WRITTEN, which is not the same as `[]`: a first
  // visit may seed defaults, a visit after the operator deleted every route
  // must not bring them back.
  const stored = (await store.load()) ?? [];
  routes = hydrate(stored);
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
    const res = await endpoint(
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

  el("join-form").hidden = !state.controls.join;
  el("session-controls").hidden = !(state.controls.disconnect || state.controls.reconnect);
  el<HTMLButtonElement>("reconnect").hidden = !state.controls.reconnect;
  el<HTMLButtonElement>("disconnect").hidden = !state.controls.disconnect;

  const phase = state.phase;
  if (phase.kind === "needs-invitation") {
    el("session-status").textContent = phase.message;
  } else if (phase.kind === "disconnected" || phase.kind === "blocked" || phase.kind === "failed") {
    el("live-status").textContent = phase.message;
  } else if (phase.kind === "live") {
    el("live-status").textContent = phase.note ?? `Joined by ${phase.joinedBy}. Proxying.`;
  }
}

async function main(): Promise<void> {
  await ensureBiscuit();
  await reloadRoutes();
  const relayAddrs = await readRelayAddrs();

  const mounts = createMounts();
  // Built ONCE; `routes` is re-read per request through the thunk.
  endpoint = routeTable({ routes: () => routes });
  mounts.provide("/proxy", endpoint);

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

  el<HTMLButtonElement>("join").addEventListener("click", () => {
    const text = el<HTMLInputElement>("invite").value.trim();
    if (text !== "") void session?.join(text);
  });
  el<HTMLButtonElement>("disconnect").addEventListener("click", () => void session?.disconnect());
  el<HTMLButtonElement>("reconnect").addEventListener("click", () => void session?.reconnect());
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
