# httpeers demos

Four pages, four origins, one mesh — the deployed demonstration of these
libraries.

| Page | Domain | What it is |
|---|---|---|
| `hub` | hub.httpeers.net | Creates the mesh and mints invitations |
| `images` | images.httpeers.net | A provider: serves a gallery to the mesh — photographs fetched from a public stock, plus any picture you choose or take |
| `app` | app.httpeers.net | A consumer: finds providers and calls them with a bare `fetch()` |
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
```

`join-smoke` is the one that matters: it serves the BUILT pages from four ports
so each gets its own origin, then drives a real join over a real WebRTC
circuit. It depends on `relay.httpeers.net` being up.

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
