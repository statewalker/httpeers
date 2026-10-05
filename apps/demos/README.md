# @statewalker/httpeers-demos

## What it is

Four static pages on four origins that form one mesh — the deployed
demonstration of the httpeers libraries. Private: built and published as sites,
never to npm.

| Page | Domain | What it is |
|---|---|---|
| `hub` | hub.httpeers.net | creates the mesh in a browser tab and mints invitations (shown as QR codes); serves search and a small app at `/spa` |
| `images` | images.httpeers.net | a provider: serves a gallery to the mesh — stock photographs, plus any picture you choose or take |
| `app` | app.httpeers.net | a consumer: finds providers and calls them with a bare `fetch()`; opens a peer's app in a session origin of its own |
| `proxy` | proxy.httpeers.net | exposes an outside origin to the mesh |

## Layout

| Path | What it is |
|---|---|
| `src/<page>/index.html`, `src/<page>/main.ts` | one entry per page |
| `vite.<page>.config.ts`, `vite.shared.ts` | one Vite build per page |
| `src/shared/` | the browser-tab hub runtime, search, the image gallery, the proxy upstream, `session-frame.ts`, `demo-spa.ts` |
| `public/reset.html` | the per-origin reset page |
| `scripts/` | `copy-assets.mjs` (run before every build), `deploy.mjs`, and the smokes |

## How to run it

1. Build the workspace packages the pages bundle: `pnpm turbo build` at the
   repository root.
2. `pnpm --filter @statewalker/httpeers-demos dev:hub` (or `dev:images`,
   `dev:app`, `dev:proxy`) for one page, or
   `pnpm --filter @statewalker/httpeers-demos build` for all four into
   `dist/<page>/`.
3. `pnpm --filter @statewalker/httpeers-demos join-smoke` — the check that
   matters: it serves the **built** pages from four local ports (four origins)
   and drives a real join over a real WebRTC circuit through
   `relay.httpeers.net`, which must be up.

To publish, from `apps/demos`:

1. `pnpm run build`
2. `node scripts/deploy.mjs --root <bucket-dir> --dry-run` — read it.
3. `node scripts/deploy.mjs --root <bucket-dir>`
4. `node scripts/live-smoke.mjs` — `join-smoke` against the real domains.

`<bucket-dir>` holds one directory per domain (`hub.httpeers.net/`, …). It is
typically an rclone FUSE mount of the sites bucket, so a write there is live at
once.

## Why it is the way it is

### Each page is its own build because each must be its own origin

A ServiceWorker's scope is an origin, and the edge that routes mesh calls is a
ServiceWorker. Four pages on one origin would share one worker and prove
nothing.

### Pages read the relay address at runtime

There is no per-site configuration. Pages read the relay's address from
`https://relay.httpeers.net/.well-known/httpeers-relay.json`, which the relay
writes and Caddy serves with `Access-Control-Allow-Origin: *`. The hub page is a
hub in a browser tab, so there is no `httpeers.json` either.

### Every joining page shares one widget

`app`, `images` and `proxy` each mount the join widget from
`@statewalker/httpeers-join` into `#mesh-join`: paste or scan an invitation,
see the link to the hub (`Connected (direct)` or `Connected (relay)`),
Disconnect, Reconnect, and **Leave this mesh…**, which forgets this origin's
identity after a confirmation. The widget's **Invite someone** panel needs the
hub's admin API (`/hub/api/*`), which the browser-tab hub does not have, so it
stays hidden here. Each page's `render()` feeds the widget every `SessionState`;
the smokes fill `.hp-join-input` and press `.hp-join-submit`.

### A mesh app runs in its own origin

The hub serves a single-page app at `/spa` (`src/shared/demo-spa.ts`) and
advertises it as `kind: "app"`. The app page's **Open in a new session** button
opens it in a fresh `<random>.p.httpeers.net` origin
(`src/shared/session-frame.ts`):

1. `openSession` from `@statewalker/httpeers-session-shell/client` frames that
   origin's `relay.html` and hands it a `MessagePort`;
2. two services share that one port:
   - `/` is `pinnedPeer` from `httpeers-ghost`, holding the hub's peer id, so
     every request the app makes at its own root reaches **the hub and nothing
     else**;
   - `/peers/` is `createGateway` from `httpeers-member`, so the app can address
     **any peer this page can see** by naming it in the path;
3. an iframe shows `https://<random>.p.httpeers.net/`, and the session's worker
   answers `index.html`, `app.js` and a root-absolute `/api/hello` from the hub,
   over the mesh.

The page renders three calls into `#mesh-get`, `#mesh-post` and `#mesh-missing`:
`GET /peers/<peerId>/spa/api/hello`, `POST /peers/<peerId>/spa/api/echo` (its
body must arrive intact, including in Firefox, which has no
`Request.prototype.body`), and a `/peers/` path naming a non-member, which must
come back as a refusal rather than a hang.

A session is a different origin: its storage, cookies and worker are its own,
it cannot read the app page's DOM, and the iframe sandbox keeps it from
navigating the app page away. A same-origin iframe would let a hostile app read
the viewer's storage and identity key and rewrite its DOM. Every click opens a
new session, so opening the app twice shows two origins that share nothing.
An app in a session can reach any peer the app page can see; the boundary is
each **target** peer's own ingress policy (`docs/security-model.md` §6). The app
never sees the membership token — this page's edge attaches it after the
request has left the session.

### Two file inputs, because one input can only do half

The images page has two file inputs. `accept="image/*"` alone lets a phone offer
the camera *or* the photo library; adding `capture="environment"` goes straight
to the rear camera and removes the ability to pick an existing file. Neither
uses `getUserMedia`: a file input with `capture` gets the photograph with no
permission prompt, no video element and no camera left running in a background
tab. Nothing is re-encoded; a chosen picture reaches the mesh through the same
`{ info, bytes }` path as a fetched one. `join-smoke` and `live-smoke` hand the
picker a generated 123×45 PNG and assert that an image of exactly those
dimensions decodes in the consumer's gallery.

### The deploy script refuses more than it does

A write to the bucket is live immediately, hence `--dry-run`, and hence the
refusals: `deploy.mjs` never creates a domain directory (an absent one is a typo
or an unprovisioned domain, and publishing to a folder nobody serves fails
silently), never touches a domain outside its table (`img.` and
`test.httpeers.net` share the bucket), and never deletes outside `assets/`. It
does empty `assets/`, because those file names are content-hashed: a new bundle
never overwrites the old one, it accumulates beside it.

## What will surprise you

- **Pages bundle workspace packages from `dist/`.** The packages' `exports`
  have a `source` condition, but these Vite configs set no
  `resolve.conditions`. After changing a package, rebuild it (or
  `pnpm turbo build`) and check that the page's `index-<hash>.js` changed; an
  unchanged hash means the change is not in the bundle.
- **A returning visitor can be stuck on an old worker.** A ServiceWorker
  registration survives a reload, and `unregister()` does not evict the worker
  controlling the page. Every page links `/reset.html`, which unregisters all
  workers, deletes every IndexedDB database and clears local and session
  storage for that origin, then asks you to close the tab: only a fresh
  navigation is guaranteed to get the new worker.
- **`session-smoke` tests whatever is deployed.** It runs on the real domains
  and needs the hub and app pages, and the session shell (published separately
  by `apps/session-shell/scripts/deploy.mjs` to `p.httpeers.net`), published
  from the build you mean to test.
- **The QR camera button is hidden on an insecure origin**, where the browser
  has no camera API. The picture button stays.

## Reference

| Command (`pnpm --filter @statewalker/httpeers-demos …`) | What it does |
|---|---|
| `build` | all four pages into `dist/<page>/` |
| `build:hub`, `build:images`, `build:app`, `build:proxy` | one page |
| `dev:hub`, `dev:images`, `dev:app`, `dev:proxy` | Vite dev server for one page |
| `test`, `typecheck`, `lint:check` | Vitest, `tsc --noEmit`, Biome |
| `smoke` | one built page, headless |
| `join-smoke` | all four built pages on four local ports, live relay |
| `live-smoke` | the same against the real domains |
| `session-smoke` | hub + app on the real domains: a mesh app in two session origins, Chromium and Firefox |
| `deploy` | `scripts/deploy.mjs` (pass `--root <bucket-dir>` and `--dry-run` when running it directly) |
