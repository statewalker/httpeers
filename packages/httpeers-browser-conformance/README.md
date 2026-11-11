# @statewalker/httpeers-browser-conformance

## What it is

Private. The httpeers checks that only a real browser can answer: how a
ServiceWorker is installed and removed, whether `resetBrowserState()` really
returns an origin to a first visit, whether Biscuit tokens work in a page with
no setup, and whether the ServiceWorker edge (`mountEdge`) survives every kind
of reload. It is never published and nothing depends on it.

## Why it exists

A ServiceWorker outlives the tab that registered it and is reused by every
later visit to the origin. A reload does not remove it, and `unregister()`
leaves the current controller in place until the page goes away. None of that
can be shown under Node or happy-dom, and getting it wrong leaves a user stuck
with an old worker and an old identity. These tests run the real thing in
Chromium and Firefox.

## How to use

The package's `test` script only prints a reminder, so `pnpm test` at the root
does not need a browser. Run the browser checks explicitly:

```sh
pnpm --filter @statewalker/httpeers-browser-conformance exec playwright install chromium firefox

# Vitest browser mode, headless Chromium:
pnpm --filter @statewalker/httpeers-browser-conformance test:browser

# mountEdge across reloads, in Chromium and Firefox (reads httpeers-member's dist/):
pnpm --filter @statewalker/httpeers-member build
pnpm --filter @statewalker/httpeers-browser-conformance test:reload

# A POST through the real gateway -> member edge -> libp2p chain, in Chromium and Firefox
# (reads the Node-side relay's and hub's dist/; CI runs this as ci.yml's forwarded-body job):
pnpm --filter "@statewalker/httpeers-browser-conformance..." run build
pnpm --filter @statewalker/httpeers-browser-conformance test:forwarded-body
```

`PLAYWRIGHT_FIREFOX_PATH` / `PLAYWRIGHT_CHROMIUM_PATH` point `test:forwarded-body` at a
browser executable outside Playwright's default install; `--browsers chromium` runs one engine,
and `--paths per-exchange` or `--paths mux` one exchange path (both by default: one libp2p stream
per exchange, and httpeers-libp2p's experimental one mux per peer, issue #56).

## Examples

| File | What it checks |
|---|---|
| `tests/sw-lifecycle.test.ts` | a worker registers and activates; survives a reload; is removed by `unregister()`; keeps controlling the page after `unregister()` until the page goes; IndexedDB outlives the worker |
| `tests/reset.test.ts` | `resetBrowserState()` removes the worker, the databases and the stored values together; is safe with nothing to remove; reports what it removed |
| `tests/biscuit.test.ts` | a page imports `@statewalker/httpeers-access` the ordinary way and mints, verifies and authorizes tokens, and fetches no `.wasm` |
| `scripts/forwarded-body.mjs` | a real browser member joins a loopback mesh (the deployed relay, a hub with an `/echo` stub) and POSTs 76 B, 1 MiB and — where the engine can build one — a 512 KiB stream through `fetch()` → ServiceWorker → `createGateway` → the member edge → the peer router → libp2p; the stub reports the byte count and SHA-256 that arrived. Runs on both exchange paths, and checks at the hub that the calls rode the path named |
| `scripts/edge-reload.mjs` | first visit, normal reload, hard reload (recovered with no extra navigation), a second tab, and — against a worker that ignores `CLAIM` — the single fallback reload and its spent guard |

## Internals

### The reload check is a script, not a Vitest test

What is under test is what a reload does, and a Vitest browser test runs inside
the page it would have to reload. `scripts/edge-reload.mjs` drives Playwright
directly against a small page that mounts an edge answering `pong`, and asserts
after every load that `mountEdge` resolved and a `fetch()` through the edge
returned `pong`. Nothing is bundled: the page imports `httpeers-member`'s
`dist/edge.js`, so build that package first.

### The forwarded-body check crosses the real chain, not a stand-in

Firefox has no `Request.prototype.body`, so a forwarder that rebuilds a request
from `request.body` (or with `new Request(url, request)`, which reads the same
property) sends it on empty, silently. That defect reached five sites while
every local suite was green, because the session shell's `browser-test.mjs`
serves the mesh with a stand-in handler and its POST never reaches
`createGateway`, the member edge or libp2p (issue #22). This script runs those
forwarders for real: only the peer at the far end is a stub. With the fix in
`edge-dispatch.ts` or in `router.ts` reverted, or `gateway.ts` reading
`request.body`, Firefox reports `0 bytes of 76 arrived`. The page is bundled
with Vite from the packages' sources on every run; the Node side (relay, hub)
imports their `dist/`.

### Browser tests run against sources, not `dist/`

`vitest.browser.config.ts` aliases every `@statewalker/*` workspace package to
its `src/`. Without the aliases the `exports` maps send Vitest to `dist/`, and
the suite would silently test the last build. It also aliases the
`@statewalker/webrun-*` packages to sources in a `webrun-wire` checkout next to
this repository (`../../../webrun-wire/packages/` from this directory); without
that checkout, `test:browser` fails while loading its config.

### No Biscuit setup is the point

`vitest.browser.config.ts` carries no Biscuit alias, loader or optimizer
exclusion. `tests/biscuit.test.ts` passing under that config is the evidence
that a page needs no setup to use tokens.

## License

MIT
