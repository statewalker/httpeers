# httpeers session shell

The static files every **`{name}.p.httpeers.net`** serves — `123123.p.httpeers.net`,
`foobar.p.httpeers.net`, any name at all. They are empty sessions: a ghost app on
`*.httpeers.net` frames one, hands it a `MessagePort`, and from then on **every request
made inside that origin — `index.html` first — is answered by the ghost app**, which
usually forwards it to one peer in the mesh.

Every name serves the same bytes, yet every name is its own **origin**, so each session
gets its own `localStorage`, IndexedDB, cookies and ServiceWorker. That is the point of
it: a mesh app shown in a session cannot read the ghost app's storage, identity key or
DOM, which a same-origin iframe could (see `docs/security-model.md`).

```ts
import {
  APP_SERVICE_KEY,
  MESH_PREFIX,
  MESH_SERVICE_KEY,
  openSession,
} from "@statewalker/httpeers-session-shell/client";

const session = await openSession({
  services: [
    { key: APP_SERVICE_KEY, path: "/", handler: serveTheApp },
    { key: MESH_SERVICE_KEY, path: MESH_PREFIX, handler: serveTheMesh },
  ],
});
iframe.src = session.url("/"); // https://<random>.p.httpeers.net/
```

`openSession` is `@statewalker/webrun-http-browser`'s
[relay mode](https://github.com/statewalker/webrun-wire/tree/main/packages/webrun-http-browser#relay-mode--cross-origin)
and nothing more: `newRemoteRelayChannel` frames `https://<name>.p.httpeers.net/relay.html`
and `initHttpService` registers each service under its key, mounted at its path. Written
out by hand it is the snippet in the relay-mode README, once per service.

## What a session serves

A session serves **the services its app registers**, each at a path the app chooses, and
all of them over **one** relay connection. That is what `webrun-http-browser` 0.6.0
changed: a `CONNECT` reaches only the service its key names, so a second service needs no
second port, no second worker and no second origin. The demo registers two:

| Mounted at | Key | What it is |
|---|---|---|
| `/` | `APP_SERVICE_KEY` (`app`) | The app. `/` is the origin root, which is why the app's **root-absolute** URLs — `/app.js`, `/api/hello` — reach the peer that serves it instead of the viewer's own origin. |
| `/peers/` | `MESH_SERVICE_KEY` (`mesh`) | The mesh (`MESH_PREFIX`), in the member edge's own shape: `/peers/<peerId>/<path>`. **Reserved — an app can never own it.** |

Three properties of that arrangement are easy to get wrong:

- **The mount prefix is not stripped.** A handler mounted at `/peers/` is called with
  `/peers/<peerId>/...`, not `/<peerId>/...`. That is exactly what
  `createGateway({ basePath: "/peers" })` expects, because the gateway strips the prefix
  itself; stripping it at the mount as well would hand the member's edge a path with no
  peer in it. `tests/browser/ghost.ts` asserts it in a real browser by answering with the
  pathname its handler was given.
- **Longest prefix wins**, after a trailing slash is normalised away. `/peers/` outranks
  the app's `/` — and so would *any* mount deeper than `/`, which is why the set of keys
  is closed (below).
- **The shell's own paths are excluded from every mount.** `/relay.html`, `/relay-sw.js`
  and `/_shell/...` come from the network with Caddy's headers, even though the app's
  mount at `/` claims every path. Without that exclusion a session could not bootstrap
  itself at all.

What a session can *do* is whatever its services' handlers allow, and nothing else. In
the demo (`apps/demos/src/shared/session-frame.ts`) that is: the pinned peer, through
`httpeers-ghost`'s `pinnedPeer` at `/`, which holds the peer id itself so the app cannot
steer the root anywhere; and any peer the ghost app can see, through `createGateway` at
`/peers/`, bounded by each target peer's own ingress policy. The app never sees the
membership token — the ghost's edge attaches it after the request has left the session.

### Why the keys are an allowlist, and why the unused ones are still held

This is the least obvious thing in the design, and both halves of it are load-bearing.

A session name is **not a secret**, and `frame-ancestors` lets any `*.httpeers.net` page
frame a session's `relay.html`. So a second, hostile ghost app can reach a live session's
relay and ask it to register something.

- `canRegisterService` (`src/policy.ts`) refuses any key outside `SESSION_SERVICE_KEYS` —
  `app`, `mesh`, and the default `session`. "Keys are the caller's" is the *library's*
  rule, and right for a library; a session is a host with a threat model, so it names its
  services. Adding one is a one-line change, which is the point: visible rather than open.
- `openSession` then **reserves the whole key space**: for every allowlisted key the
  caller did not use, it registers a live placeholder that refuses everything with `410`,
  deliberately with **no path** — `initHttpService` mounts a service only when it is given
  one, so a placeholder is reachable at `/~<key>/` and nowhere else and can never compete
  with a real mount.

The reservation exists because `takeover: "first-wins"` defends a key that is *held* and
says nothing about a key nobody asked for. An app that registered only `app` would leave
`mesh` unheld; a second ghost could take `mesh`, mount it at `/index.html` — which
normalises to a longer prefix than the app's `/` — and serve the session's own index page
without ever taking a key away from the app. Holding the key defeats that exactly as a
real registration would, without asking every caller to remember to do it.
What is tested where: the **allowlist** is measured in a real browser — a second ghost
asking for `evil` at `/index.html` is refused, and `/index.html` is still the app's
(`scripts/browser-test.mjs`). The **reservation** is unit-tested instead
(`tests/client.test.ts`): `reservedPlaceholders` is a pure function of the requested
services and the allowlist, and `openSession` itself needs a browser while that function
does not.

## What is in the shell

| Path | What it is |
|---|---|
| `/relay.html` | Framed, hidden, by the ghost app. Registers the worker and bridges the ghost's port to it. |
| `/relay-sw.js` | The worker. Answers every path below, over the port. |
| `/_shell/*` | The relay page's script. Content-hashed. |
| `/peers/*` | Reserved for the mesh (`MESH_PREFIX`), the same shape the member edge serves. Never the app's. |
| `/index.html` | A fallback that says nothing is connected. The network serves it only when no worker is installed — with a connected session the worker answers `/index.html` from the app like any other path. |
| `.site/config.json` | `{ "notFound": "/index.html" }` for the sites app. Never served. |

**Everything else belongs to the app.** An app cannot serve `/relay.html`,
`/relay-sw.js`, anything under `/_shell/`, or anything under `/peers/`; that is the
shell's whole footprint.

## What the shell refuses

The session name is **not a secret** — it travels through DNS resolvers, `Referer`
headers, history and logs. So nothing treats knowing a name as authority, and each of
these is enforced by code in `src/`, tested in a real browser:

| Refusal | Where | Why |
|---|---|---|
| A page that is not on `httpeers.net` or one label under it cannot frame a session | `frame-ancestors`, from Caddy on the shell's files and from the worker on everything it answers | A worker-made response carries only the headers the worker gives it |
| **Another session** cannot hand a relay its port | `relay.ts` → `isAllowedParentOrigin` | Every session is itself under `httpeers.net`, so `frame-ancestors` lets it frame another; CSP cannot say "except" |
| A second ghost app cannot take over a live session | `sw.ts` → `takeover: "first-wins"` | The relay worker's default lets any client re-register a key; here the first live registrant keeps it until its relay page is gone |
| Only `/relay.html` may register the app | `sw.ts` → `canRegister` → `canRegisterService` | Anything else on the origin is the app itself |
| A ghost cannot invent a service key | `policy.ts` → `SESSION_SERVICE_KEYS` | `first-wins` defends a key that is *held*; a key nobody asked for could otherwise be mounted deeper than the app's root and outrank it |
| A second ghost cannot take an allowlisted key the app left unused | `client.ts` → `reservedPlaceholders` | `openSession` holds every key it is not using, with a refusing handler and no path — see [Why the keys are an allowlist](#why-the-keys-are-an-allowlist-and-why-the-unused-ones-are-still-held) |
| A navigation must come from the session itself or a ghost-app origin | `sw.ts` → `navigationAllowed` (the `Referer`) | A page can withhold a referrer but not forge one; so a top-level visit, or a form posted from a foreign site, is refused with 403 instead of reaching the app with the viewer's credentials |

What a session **may** do is whatever its services' handlers allow. That is the whole of
its authority: in the demo the root is `httpeers-ghost`'s `pinnedPeer`, which reaches the
one peer that serves the app and cannot be steered off it, and `/peers/` is
`httpeers-member`'s `createGateway`, which reaches any peer the ghost app can see —
bounded there by each target peer's own ingress policy, not by the session.

## How it differs from the library's relay worker

It **is** the library's relay worker: `src/sw.ts` calls `startRelayServiceWorker` from
`@statewalker/webrun-http-browser/relay-worker`, so registration, the client registry
(kept in IndexedDB, because a browser stops an idle worker after about thirty seconds),
routing and the `REGISTER` / `UNREGISTER` / `CONNECT` plumbing are all the library's.
Since 0.6.0 a service claims a path prefix — the origin root included — so the routing
this file used to hand-roll is gone. What is left is what the library cannot know:

- **The refusals above**, as the worker's options: `exclude` keeps the shell's own files
  off the app's root mount, `canRegister` limits registration to `/relay.html`,
  `takeover: "first-wins"` keeps a live session with its app, and `decorateResponse`
  stamps `frame-ancestors` on every answer the relay makes. `canRegister` also checks
  the KEY against `SESSION_SERVICE_KEYS`: a session names its services.
- **The navigation check is the shell's own `fetch` listener, registered before the
  library's.** It needs `request.mode` and `request.referrer`, which `exclude` (a URL)
  and `decorateResponse` (after the answer) cannot see, and it must refuse before the
  request crosses the port. The first listener to call `respondWith` owns the request.
- **A relay failure a human will read becomes a page** (`src/errors.ts`), not the
  library's JSON envelope — a session's `index.html` is a navigation. Only the relay's
  *own* envelope is rewritten: `decorateResponse` also carries the app's answers, so an
  app's own 404 page and its redirects pass through untouched.
- **The relay page talks to `registration.active`, not `navigator.serviceWorker.controller`.**
  Measured in Firefox 155: the first relay page on an origin is claimed and controlled,
  but a later one — a second tab, or the same ghost reloaded — loads with the worker
  active and `controller` null. The library's relay page waits for a `controllerchange`
  that never comes, and the ghost's `REGISTER` is never answered.

**What the shell no longer does, and where it went.** `src/sw.ts` used to hand-roll a
client registry, the `REGISTER` / `UNREGISTER` / `CONNECT` messages, and the routing that
decided which client answered a path — all of it because the library's relay could only
serve `/~<key>/` and a session needs the origin root. Since
`@statewalker/webrun-http-browser` **0.6.0** a service claims a path prefix, the root
included, and a `CONNECT` reaches only the service its key names. So all of that is the
library's again, in `@statewalker/webrun-http-browser/relay-worker`, and `src/sw.ts` is
one `startRelayServiceWorker` call plus the httpeers policy above. Every httpeers package
names `@statewalker/webrun-http-browser@^0.6.0`; nothing here reimplements a part of it.

## Build, test, publish

```sh
pnpm run build            # dist/site (the shell) and dist/lib (the ./client export)
pnpm test                 # unit tests: names, origins, referrers, the Caddyfile drift check
pnpm run browser-test     # the built shell in Chromium and Firefox, on two localhost origins
node scripts/deploy.mjs --root <bucket-dir> --dry-run
node scripts/deploy.mjs --root <bucket-dir>
pnpm run live-check       # DNS, TLS, HTTP and the refusals, on fresh names of the real domain
```

`browser-test` runs the real protocol with the built worker: **two services over one
connection** — the app at `/` and a stand-in for the mesh at `/peers/`, each answering
with which of them got the request and with the un-stripped pathname it was given — a
root-absolute script and a POST with a body, a stopped worker restarting (Chromium), the
shell's own files bypassing the app, a second ghost refused, a key outside the allowlist
refused, a top-level visit refused, and the session freed once its ghost is gone. It serves every session
name from ONE local origin, so it proves the protocol, not the per-name isolation. A
shell served from `localhost` accepts `localhost` parents; the deployed rule never does.

`live-check` uses **fresh random names** every run, because a name that has its own DNS
record, site block or certificate would pass while the wildcard was broken. The
isolation between two sessions, with a mesh app in each, is checked by `apps/demos`'s
`scripts/session-smoke.mjs`.

`deploy.mjs` writes one directory, `<bucket-dir>/p.httpeers.net`, which every session
name reads because Caddy rewrites their `Host` to `p.httpeers.net`. It refuses to run
against an unmounted bucket, creates that directory only with `--create`, deletes only
stale files under `_shell/`, and writes `relay.html` last so it never names an asset
that is not there yet. Files are served `public, no-cache`, so a republished worker is
picked up on the browser's next update check.

The infrastructure it needs — the `A *.p` DNS record and the `*.p.httpeers.net` Caddy
block — is described in `deploy/README.md`.

## Caveats

- **Same site, not only same parent.** Every session is on the registrable domain
  `httpeers.net`, like the relay, `s3.` and every published site. A session can set a
  cookie for `.httpeers.net` (cookie tossing), and `SameSite` does not stop it, because
  it is the same site. Nothing in `httpeers.net` relies on cookies today. If sessions
  ever run code that must not influence the other sites, move them to a separate
  registrable domain (the way Google uses `googleusercontent.com`) or put
  `p.httpeers.net` on the Public Suffix List — change `SESSION_ZONE` / `GHOST_ZONE` in
  `src/policy.ts`, the Caddyfile block and the DNS record together.
- **Storage is partitioned by the top-level site.** A ghost app on another *site* would
  get a session partitioned under its own site; a session opened top-level would not see
  the iframe's worker. With every ghost app on `httpeers.net` today, the frame and a
  top-level visit share one partition — which is why the worker refuses a top-level
  visit rather than serving it.
- **An app must not suppress its own `Referer`.** A `Referrer-Policy: no-referrer` on
  the app's pages, or `rel="noreferrer"` on its internal links, makes its own
  navigations look like foreign ones, and the worker refuses them.
- **Not verified in Safari.** Chromium and Firefox are measured; WebKit's handling of a
  worker in a same-site iframe is not.
