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
import { openSession } from "@statewalker/httpeers-session-shell/client";

const session = await openSession({ handler: (request) => serveTheApp(request) });
iframe.src = session.url("/"); // https://<random>.p.httpeers.net/
```

`openSession` is `@statewalker/webrun-http-browser`'s
[relay mode](https://github.com/statewalker/webrun-wire/tree/main/packages/webrun-http-browser#relay-mode--cross-origin)
and nothing more: `newRemoteRelayChannel` frames `https://<name>.p.httpeers.net/relay.html`
and `initHttpService` registers `handler` as the session's one service. Written out by
hand it is the snippet in the relay-mode README, with the service key fixed to
`"session"`.

## What is in the shell

| Path | What it is |
|---|---|
| `/relay.html` | Framed, hidden, by the ghost app. Registers the worker and bridges the ghost's port to it. |
| `/relay-sw.js` | The worker. Answers every path below, over the port. |
| `/_shell/*` | The relay page's script. Content-hashed. |
| `/index.html` | A fallback that says nothing is connected. The network serves it only when no worker is installed — with a connected session the worker answers `/index.html` from the app like any other path. |
| `.site/config.json` | `{ "notFound": "/index.html" }` for the sites app. Never served. |

**Everything else belongs to the app.** An app cannot serve `/relay.html`,
`/relay-sw.js` or anything under `/_shell/`; those three are the shell's whole footprint.

## What the shell refuses

The session name is **not a secret** — it travels through DNS resolvers, `Referer`
headers, history and logs. So nothing treats knowing a name as authority, and each of
these is enforced by code in `src/`, tested in a real browser:

| Refusal | Where | Why |
|---|---|---|
| A page that is not on `httpeers.net` or one label under it cannot frame a session | `frame-ancestors`, from Caddy on the shell's files and from the worker on everything it answers | A worker-made response carries only the headers the worker gives it |
| **Another session** cannot hand a relay its port | `relay.ts` → `isAllowedParentOrigin` | Every session is itself under `httpeers.net`, so `frame-ancestors` lets it frame another; CSP cannot say "except" |
| A second ghost app cannot take over a live session | `sw.ts`, `REGISTER` | The library's relay worker lets any client re-register a key; here the first live registrant keeps it until its relay page is gone |
| Only `/relay.html` may register the app | `sw.ts`, `REGISTER` | Anything else on the origin is the app itself |
| A navigation must come from the session itself or a ghost-app origin | `sw.ts` → `navigationAllowed` (the `Referer`) | A page can withhold a referrer but not forge one; so a top-level visit, or a form posted from a foreign site, is refused with 403 instead of reaching the app with the viewer's credentials |

What a session **may** do is whatever the ghost's `handler` allows. That is the whole of
its authority, and it is why the demo's handler is `httpeers-ghost`'s `pinnedPeer`: the
app can reach the one peer that serves it and nothing else.

## How it differs from the library's relay worker

It speaks the same protocol (`REGISTER` / `UNREGISTER` / `CONNECT` over `callChannel`,
then `sendHttpRequest`), so the ghost side is the unmodified library. What differs:

- **Routing.** The library worker serves only `/~<key>/...` URLs — and finds the `~`
  anywhere in the URL, query string included. A session serves one app at its root.
- **The refusals above.** The library worker has none of them.
- **The relay page talks to `registration.active`, not `navigator.serviceWorker.controller`.**
  Measured in Firefox 155: the first relay page on an origin is claimed and controlled,
  but a later one — a second tab, or the same ghost reloaded — loads with the worker
  active and `controller` null. The library's relay page waits for a `controllerchange`
  that never comes, and the ghost's `REGISTER` is never answered.
- **The registration survives the worker being stopped.** It is kept in IndexedDB,
  because a browser stops an idle worker after about thirty seconds.

## Build, test, publish

```sh
pnpm run build            # dist/site (the shell) and dist/lib (the ./client export)
pnpm test                 # unit tests: names, origins, referrers, the Caddyfile drift check
pnpm run browser-test     # the built shell in Chromium and Firefox, on two localhost origins
node scripts/deploy.mjs --root <bucket-dir> --dry-run
node scripts/deploy.mjs --root <bucket-dir>
pnpm run live-check       # DNS, TLS, HTTP and the refusals, on fresh names of the real domain
```

`browser-test` runs the real protocol with the built worker: an app served into a
session, a root-absolute script and a POST with a body, a stopped worker restarting
(Chromium), the shell's own files bypassing the app, a second ghost refused, a top-level
visit refused, and the session freed once its ghost is gone. It serves every session
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
