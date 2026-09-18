# httpeers demos

Four pages, four origins, one mesh — the deployed demonstration of these
libraries.

| Page | Domain | What it is |
|---|---|---|
| `hub` | hub.httpeers.net | Creates the mesh and mints invitations; serves search and a small app (`/spa`) |
| `images` | images.httpeers.net | A provider: serves a gallery to the mesh — photographs fetched from a public stock, plus any picture you choose or take |
| `app` | app.httpeers.net | A consumer: finds providers and calls them with a bare `fetch()`; opens a peer's app in a session origin of its own |
| `proxy` | proxy.httpeers.net | Exposes an outside origin to the mesh |

Each page is its own Vite build with its own entry, because each must be its
own ORIGIN: a ServiceWorker's scope is an origin, and the edge that routes mesh
calls is a ServiceWorker. Four pages on one origin would share one worker and
prove nothing.

## Build and run locally

```sh
npm run build            # all four into dist/<page>/
npm run dev:hub          # or dev:images, dev:app, dev:proxy
npm run smoke            # one page, headless
npm run join-smoke       # all four, served on four local ports, LIVE relay
npm run session-smoke    # hub + app on the REAL domains: a mesh app in two session origins
```

`join-smoke` is the one that matters: it serves the BUILT pages from four ports
so each gets its own origin, then drives a real join over a real WebRTC
circuit. It depends on `relay.httpeers.net` being up.

## A mesh app in its own origin

The hub serves a small single-page app at `/spa` (`src/shared/demo-spa.ts`) and
advertises it as `kind: "app"`. The app page's **Open in a new session** button opens it
in a fresh `<random>.p.httpeers.net` origin (`src/shared/session-frame.ts`):

1. `openSession` from `apps/session-shell` frames that origin's `relay.html` and hands it
   a `MessagePort` — `webrun-http-browser`'s relay mode;
2. the port's handler is `httpeers-ghost`'s `pinnedPeer`, so every request the app makes
   reaches **the hub and nothing else**, through this page's member;
3. an iframe shows `https://<random>.p.httpeers.net/`, and the session's worker answers
   `index.html`, `app.js` and a root-absolute `/api/hello` from the hub, over the mesh.

This replaces the same-origin ghost iframe. That frame shared the viewer's origin, and a
hostile app in it read the viewer's storage and identity key and rewrote its DOM
(measured 2026-09-15). A session is a different origin: its storage, cookies and worker
are its own, it cannot read the app page's DOM, and the sandbox attribute keeps it from
navigating the app page away. Every click is a new session, so opening the app twice
shows two origins that share nothing.

`npm run session-smoke` checks all of that on the real domains, in Chromium and Firefox.

## Adding your own picture

The images page has two file inputs, and the split is deliberate.
`accept="image/*"` alone lets a phone offer the camera *or* the photo library;
adding `capture="environment"` goes straight to the rear camera and **removes**
the ability to pick an existing file. Either one alone is half the feature, so
there are two.

Neither asks for `getUserMedia`: a file input with `capture` gets the same
photograph with no permission prompt to manage, no video element to tear down,
and no camera left running when the tab is backgrounded.

Nothing is re-encoded. The bytes are served exactly as given, and a chosen
picture reaches the mesh through the same `{ info, bytes }` path a fetched one
does — no other peer can tell them apart.

`join-smoke` and `live-smoke` prove this end to end by handing the picker a
generated 123x45 PNG and then asserting an image of exactly those dimensions
decodes in the *consumer's* gallery. The `capture` control is the same code
path, but the camera itself cannot be exercised headlessly.

## Deploy

```sh
npm run build
node scripts/deploy.mjs --root <bucket> --dry-run   # read this first
node scripts/deploy.mjs --root <bucket>
node scripts/live-smoke.mjs                          # verify
```

`<bucket>` holds one directory per domain. In this workspace it is
`umbrella-next/s3.httpeers.net`, an **rclone FUSE mount** — a write there is
live immediately, with no staging step between the script and a visitor. Hence
`--dry-run`, and hence the script's refusals: it never creates a domain
directory (an absent one means a typo or an unprovisioned domain, and
publishing to a folder nobody serves fails silently), never touches a domain
outside its table (`img.` and `test.httpeers.net` share the bucket), and never
deletes outside `assets/`.

It DOES empty `assets/`, because those filenames are content-hashed: a new
bundle never overwrites the old one, it accumulates beside it. The first real
deploy cleared 6–12 orphaned bundles per site.

`session-smoke.mjs` is the session check above; it needs the hub and app pages published
from a build that has the `/spa` mount, and the session shell published by
`apps/session-shell/scripts/deploy.mjs` (a separate prefix, `p.httpeers.net`, which this
script never touches).

`live-smoke.mjs` is `join-smoke.mjs` pointed at the real domains. Keeping the
two the same shape is the point — if one fails where the other passed, the
deployment is what changed, not the code.

## Configuration

There is none per site. Pages read the relay's address from
`https://relay.httpeers.net/.well-known/httpeers-relay.json`, which the relay
serves with `Access-Control-Allow-Origin: *`. The old deployment carried a
per-site `httpeers.json` that had to be generated and kept in step; those files
are still in the bucket and are now inert.

## When a page misbehaves for a returning visitor

A ServiceWorker registration is **origin-durable**: it survives a reload, and
`unregister()` does not evict the worker currently controlling the page. A
visitor who used an earlier deployment keeps its worker until the browser's own
update cycle replaces it.

Every page links `/reset.html`, which unregisters all workers, deletes every
IndexedDB database and clears local and session storage for that origin — then
tells you to close the tab, because only a fresh navigation is guaranteed to be
controlled by the new worker. `httpeers-browser-conformance` covers the
mechanics in a real browser.
