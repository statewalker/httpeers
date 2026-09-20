/**
 * The app page: find providers in the mesh, call them with a bare `fetch()`.
 *
 * ISO-FUNCTIONAL with the sandbox's `pages/app/main.ts`, on the extracted
 * libraries.
 *
 * THE ONE THING TO CHECK IN THIS FILE: there is no peer id in it. Nothing is
 * hard-coded about who serves images or search. The page reads the mesh view,
 * finds whoever advertises the KIND it wants, and calls that peer — so the
 * demo works with any provider that joins, and keeps working when a different
 * one takes over.
 *
 * AND THE SECOND: every mesh call below is a bare `fetch()`. No SDK, no client
 * object, no `peer.call(...)`. A URL under `handle.baseUrl` goes through this
 * origin's ServiceWorker, which routes it over the mesh — which is the whole
 * point of the edge existing.
 *
 * ONE EXCEPTION, ON PURPOSE: an app opened in a session (`openApp`) does not
 * go through this page's worker at all. Its requests arrive over a port from
 * its own origin and are handed to the member in process, pinned to the one
 * peer that serves it -- see `../shared/session-frame.ts`.
 *
 * WHY THE URLS ARE COMPOSED FROM `baseUrl` AND NOT ROOT-RELATIVE. Writing
 * `fetch('/${peerId}/images')` would miss the mesh entirely: the worker keys
 * its channel on the edge prefix, so a root-relative path is just a 404 from
 * this origin. `baseUrl` already ends in that prefix and a slash.
 */

import type { MeshView, MeshViewAdvertisement } from "@statewalker/httpeers-core";
import { createMounts } from "@statewalker/httpeers-core";
import { type JoinWidget, mountJoinWidget } from "@statewalker/httpeers-join";
import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";
import type { ImageInfo } from "../shared/images.js";
import { EDGE_KEY, meshRules } from "../shared/policy.js";
import { needsPermissiveGater, readRelayAddrs } from "../shared/relay.js";
import type { SearchResult } from "../shared/search.js";
import { callThroughMember, openAppInSession } from "../shared/session-frame.js";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found == null) throw new Error(`app page: no #${id} in the markup`);
  return found;
};

let session: PeerSession | undefined;
/** Paste or scan an invitation, see the link, disconnect or leave. Mounted once the session exists. */
let joinWidget: JoinWidget | undefined;
/** The live handle, or null when this page is not joined. Read at call time, never cached across a disconnect. */
let handle: SessionState["handle"] = null;

/**
 * Who advertises `kind`, if anyone.
 *
 * `MeshView.advertisements` is a FLAT list and each entry carries its own
 * `peerId`, so this is one `find` rather than a walk through members. Read
 * fresh on every call rather than cached: a provider that left should stop
 * being called, and a different one that arrived should be picked up with no
 * reload.
 */
function provider(view: MeshView | null, kind: string): MeshViewAdvertisement | undefined {
  return view?.advertisements.find((ad) => ad.kind === kind);
}

function describe(kind: string, view: MeshView | null): string {
  const ad = provider(view, kind);
  if (ad == null) return "none in this mesh yet";
  return `${ad.title} — ${ad.peerId.slice(0, 16)}…`;
}

/**
 * A mesh call, with its failure kept legible.
 *
 * The edge answers a call to an unreachable peer with a structured error and
 * its own status, so a provider that went away reads as that rather than as a
 * parse failure three lines later.
 */
async function callMesh(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} — ${body.slice(0, 200)}`);
  }
  return res;
}

async function loadImages(): Promise<void> {
  const live = handle;
  if (live == null) return;
  const peer = provider(live.meshView(), "images")?.peerId;
  if (peer == null) {
    el("images-status").textContent = "nobody is advertising images";
    return;
  }

  el("images-status").textContent = "loading…";
  try {
    // A BARE FETCH, through this origin's ServiceWorker, over the mesh.
    const res = await callMesh(`${live.baseUrl}${peer}/images`);
    const { images } = (await res.json()) as { images: ImageInfo[] };

    el("gallery").replaceChildren(
      ...images.map((image) => {
        const figure = document.createElement("figure");
        const img = document.createElement("img");
        // The BYTES come over the mesh too — the browser fetches this URL
        // itself, which is the clearest demonstration there is that a mesh
        // resource is an ordinary URL.
        img.src = `${live.baseUrl}${peer}/images/${image.id}`;
        img.alt = image.title;
        img.loading = "lazy";
        const caption = document.createElement("figcaption");
        caption.textContent = image.title;
        figure.append(img, caption);
        return figure;
      }),
    );
    el("images-status").textContent = `${images.length} from ${peer.slice(0, 16)}…`;
  } catch (err) {
    el("images-status").textContent = `could not load: ${String(err)}`;
  }
}

async function runSearch(): Promise<void> {
  const live = handle;
  if (live == null) return;
  const query = el<HTMLInputElement>("query").value.trim();
  if (query === "") return;

  const peer = provider(live.meshView(), "search")?.peerId;
  if (peer == null) {
    el("search-status").textContent = "nobody is advertising search";
    return;
  }

  el("search-status").textContent = "searching…";
  try {
    const res = await callMesh(`${live.baseUrl}${peer}/search?q=${encodeURIComponent(query)}`);
    const { results } = (await res.json()) as { results: SearchResult[] };
    el("results").replaceChildren(
      ...results.map((result) => {
        const li = document.createElement("li");
        const title = document.createElement("strong");
        title.textContent = result.title;
        const snippet = document.createElement("div");
        snippet.className = "muted";
        snippet.textContent = result.snippet;
        li.append(title, snippet);
        return li;
      }),
    );
    el("search-status").textContent = `${results.length} result(s)`;
  } catch (err) {
    el("search-status").textContent = `search failed: ${String(err)}`;
  }
}

/**
 * Open the advertised app in a fresh session origin -- see
 * `../shared/session-frame.ts` for why an origin of its own and not an iframe
 * on this one. Each click is a new session, so opening it twice shows two
 * origins that share nothing.
 */
async function openApp(): Promise<void> {
  const live = handle;
  if (live == null) return;
  const ad = provider(live.meshView(), "app");
  if (ad == null) {
    el("app-status").textContent = "nobody is advertising an app";
    return;
  }

  el("app-status").textContent = "opening a session…";
  const box = document.createElement("figure");
  box.className = "session";
  const caption = document.createElement("figcaption");
  caption.className = "mono";
  const close = document.createElement("button");
  close.textContent = "close";
  box.append(caption);
  el("sessions").append(box);
  try {
    const opened = await openAppInSession({
      peerId: ad.peerId,
      appPath: `/${ad.id}`,
      // Read the handle PER REQUEST: after a reconnect the old one is dead.
      call: (peerId, request) =>
        handle == null
          ? Promise.resolve(new Response("this page left the mesh", { status: 503 }))
          : callThroughMember(handle.fetch, EDGE_KEY)(peerId, request),
      token: () => handle?.token() ?? "",
      container: box,
    });
    caption.textContent = `${opened.session.origin} `;
    caption.append(close);
    close.addEventListener("click", () => {
      opened.close();
      box.remove();
    });
    el("app-status").textContent = `${ad.title} from ${ad.peerId.slice(0, 16)}…`;
  } catch (err) {
    box.remove();
    el("app-status").textContent = `could not open: ${String(err)}`;
  }
}

function renderApps(view: MeshView | null, live: boolean): void {
  el("app-provider").textContent = describe("app", view);
  el<HTMLButtonElement>("open-app").disabled = !live || provider(view, "app") == null;
}

function renderMesh(view: MeshView | null): void {
  if (view == null || view.members.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "muted";
    td.textContent = "not joined";
    tr.append(td);
    el("mesh").replaceChildren(tr);
    return;
  }
  el("mesh").replaceChildren(
    ...view.members.map((member) => {
      const tr = document.createElement("tr");
      const peer = document.createElement("td");
      peer.className = "mono";
      peer.textContent = `${member.peerId.slice(0, 20)}…`;
      const roles = document.createElement("td");
      roles.textContent = member.roles.join(", ");
      const ads = document.createElement("td");
      ads.textContent =
        view.advertisements
          .filter((ad) => ad.peerId === member.peerId)
          .map((ad) => ad.kind)
          .join(", ") || "—";
      tr.append(peer, roles, ads);
      return tr;
    }),
  );
}

function render(state: SessionState): void {
  handle = state.handle;
  el("state").textContent = state.phase.kind;
  el("peer-id").textContent = state.identity ?? "…";

  const view = state.handle?.meshView() ?? null;
  el("images-provider").textContent = describe("images", view);
  el("search-provider").textContent = describe("search", view);
  renderMesh(view);

  const live = state.phase.kind === "live";
  el<HTMLButtonElement>("load-images").disabled = !live;
  el<HTMLButtonElement>("do-search").disabled = !live;
  renderApps(view, live);

  // The join form, the phase and its message, and the session controls.
  joinWidget?.update(state);
}

async function main(): Promise<void> {
  const relayAddrs = await readRelayAddrs();

  session = createSession({
    key: EDGE_KEY,
    // A CONSUMER SERVES NOTHING. An empty mount table is a legitimate member:
    // it still joins, heartbeats and appears in the mesh view.
    mounts: createMounts(),
    rules: meshRules(),
    dev: needsPermissiveGater(relayAddrs),
    serviceWorkerUrl: "/sw.js",
    onChange: render,
    readDeploymentConfig: async () => null,
  });

  joinWidget = mountJoinWidget(el("mesh-join"), { session, state: session.state() });
  el<HTMLButtonElement>("load-images").addEventListener("click", () => void loadImages());
  el<HTMLButtonElement>("do-search").addEventListener("click", () => void runSearch());
  el<HTMLButtonElement>("open-app").addEventListener("click", () => void openApp());

  await session.start();

  // The mesh view changes as peers come and go, and nothing pushes it: it
  // arrives on this page's own heartbeat. Re-rendering on a timer is what
  // makes a provider appearing mid-session visible without a reload.
  setInterval(() => {
    if (session != null) render(session.state());
  }, 2_000);
}

main().catch((err: unknown) => {
  el("state").textContent = "error";
  el("error").hidden = false;
  el("error").textContent =
    `${String(err)}\n\nIf this keeps happening, reset this app from the link below.`;
});
