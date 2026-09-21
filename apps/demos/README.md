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

The pages bundle their workspace packages from `dist/` (no `source` export
condition, no `resolve.conditions`), so after changing a package run
`pnpm turbo build` from the repository root, or build that package first, and
check that the page's `index-<hash>.js` changed. An unchanged hash means the
change is not in the bundle.

## Joining a mesh

`app`, `images` and `proxy` each have a `#mesh-join` section, and the join
widget from [`@statewalker/httpeers-join`](../../packages/httpeers-join)
mounts into it. llm-chat's `mesh.html` uses the same widget. It offers:

- a field for a join link, a join blob or an invitation id;
- **Scan a QR code** (the live rear camera; hidden where the browser has no
  camera API, such as on an insecure origin) and **Scan a QR picture** (a
  screenshot or photo of the hub's QR code);
- the link to the hub (`Connected (direct)` or `Connected (relay)`), this
  page's short peer id, and the session's own message when something is wrong;
- **Disconnect** (membership kept), **Reconnect**, and **Leave this mesh…**,
  which forgets this origin's identity after a confirmation. Joining again
  then needs a new invitation;
- for a mesh admin, **Invite someone**: an invitation as a member or an admin, with its link,
  QR code, Share and Copy. It calls the hub's admin API (`/hub/api/*`), which the demos'
  browser-tab hub does not have. Here it therefore stays hidden. It appears on llm-chat's
  `mesh.html` for an admin of the appliance hub.

Each page's `render()` feeds the widget every `SessionState` and keeps its own
fields (`#state`, `#peer-id`, the mesh view). The smokes fill `.hp-join-input`
and press `.hp-join-submit`.

The hub page has no join form. It mints invitations, and shows each one as a
QR code the widget can scan.

## A mesh app in its own origin

The hub serves a small single-page app at `/spa` (`src/shared/demo-spa.ts`) and
advertises it as `kind: "app"`. The app page's **Open in a new session** button opens it
in a fresh `<random>.p.httpeers.net` origin (`src/shared/session-frame.ts`):

1. `openSession` from `apps/session-shell` frames that origin's `relay.html` and hands it
   a `MessagePort` — `webrun-http-browser`'s relay mode;
2. **two services go over that one port**, because since 0.6.0 a `CONNECT` reaches only
   the service its key names:
   - `/` is `httpeers-ghost`'s `pinnedPeer`, which holds the hub's peer id itself, so
     every request the app makes at its own root reaches **the hub and nothing else**;
   - `/peers/` is `httpeers-member`'s `createGateway`, the member edge's own shape, so the
     app can address **any peer this page can see** by naming it in the path;
3. an iframe shows `https://<random>.p.httpeers.net/`, and the session's worker answers
   `index.html`, `app.js` and a root-absolute `/api/hello` from the hub, over the mesh.

**The mount prefix is not stripped**: the gateway is mounted at `/peers/` and is called
with `/peers/<peerId>/...`, which is exactly what `createGateway({ basePath: "/peers" })`
expects — it strips the prefix itself, and stripping it twice would send the edge a path
with no peer in it.

So the demo app does both, and they are different things. `/api/hello` is the pinned root:
the session's own path, resolved to the peer that serves the app, and impossible to steer
elsewhere. `GET /peers/<peerId>/spa/api/hello` and `POST /peers/<peerId>/spa/api/echo`
name that peer explicitly, through the gateway — the shape an app uses to call a provider
it did not come from. The page reads the peer id out of `/api/hello`'s body (whoever
answered names themselves) and renders all three into `#mesh-get`, `#mesh-post` and
`#mesh-missing`. The POST is the one that matters most: Firefox has no
`Request.prototype.body`, and before the gateway read the body with core's `bodyOf` it
arrived empty, with nothing anywhere saying so.

This replaces the same-origin ghost iframe. That frame shared the viewer's origin, and a
hostile app in it read the viewer's storage and identity key and rewrote its DOM
(measured 2026-09-15). A session is a different origin: its storage, cookies and worker
are its own, it cannot read the app page's DOM, and the sandbox attribute keeps it from
navigating the app page away. Every click is a new session, so opening the app twice
shows two origins that share nothing.

An app in a session can reach any peer the app page can see, and that is deliberate —
see `docs/security-model.md` §6: the boundary is each **target** peer's own ingress
policy, not the session. The app never sees the membership token — this page's edge
attaches it after the request has left the session — and one origin per app means a
hostile app still cannot read another app's storage.

`npm run session-smoke` checks all of that on the real domains, in Chromium and Firefox:
the two origins and their isolation, the pinned root, both `/peers/` calls with the POST's
body intact, and a `/peers/` path naming something that is not a member coming back as a
refusal rather than a hang. It needs the hub, app and shell pages **published from this
branch**; run against an older deployment it tests the older deployment.

## Adding your own picture

The images page has two file inputs, and the split is deliberate.
`accept="image/*"` alone lets a phone offer the camera *or* the photo library;
adding `capture="environment"` goes straight to the rear camera and **removes**
the ability to pick an existing file. Either one alone is half the feature, so
there are two.

Neither asks for `getUserMedia` (only the join widget's live QR scanner
does): a file input with `capture` gets the same
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
