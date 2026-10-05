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
```

## Examples

| File | What it checks |
|---|---|
| `tests/sw-lifecycle.test.ts` | a worker registers and activates; survives a reload; is removed by `unregister()`; keeps controlling the page after `unregister()` until the page goes; IndexedDB outlives the worker |
| `tests/reset.test.ts` | `resetBrowserState()` removes the worker, the databases and the stored values together; is safe with nothing to remove; reports what it removed |
| `tests/biscuit.test.ts` | a page imports `@statewalker/httpeers-access` the ordinary way and mints, verifies and authorizes tokens, and fetches no `.wasm` |
| `scripts/edge-reload.mjs` | first visit, normal reload, hard reload (recovered with no extra navigation), a second tab, and — against a worker that ignores `CLAIM` — the single fallback reload and its spent guard |

## Internals

### The reload check is a script, not a Vitest test

What is under test is what a reload does, and a Vitest browser test runs inside
the page it would have to reload. `scripts/edge-reload.mjs` drives Playwright
directly against a small page that mounts an edge answering `pong`, and asserts
after every load that `mountEdge` resolved and a `fetch()` through the edge
returned `pong`. Nothing is bundled: the page imports `httpeers-member`'s
`dist/edge.js`, so build that package first.

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
