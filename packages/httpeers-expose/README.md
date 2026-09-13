# @statewalker/httpeers-expose

Make something reachable to mesh members: an in-process handler, a local
service, or a remote origin.

**The reverse proxy and "expose a local app" are one mechanism.** Twelve
scenarios establish it: only the last step differs — a local handler is
*called*, a URL upstream is *re-issued*. Matching, rewriting, the listing, the
marker header and streaming are shared.

The scenarios moved here with the code rather than being rewritten, because a
list that changes when it moves proves nothing about the move. **They run in
Node here, and only Node.** The prototype also ran them in Chromium, which is
what established that both upstream kinds behave identically on both platforms
and that exactly one row cannot pass in a browser (below). That second column
needs a bundler and a browser and does not exist in this package yet;
`tests/scenarios.test.ts` says so in its own header.

```ts
import { routeTable, urlUpstream } from "@statewalker/httpeers-expose";

const handler = routeTable({
  routes: () => [
    { prefix: "/openai", describe: "OpenAI", upstream: urlUpstream({ base: "https://api.openai.com/v1" }) },
    { prefix: "/local",  describe: "in-process", upstream: myHandler },
  ],
});
```

## `routes` may be a thunk, and that is load-bearing

The proxy page edits routes and types credentials **while traffic flows**. The
table is re-read per request for exactly that reason; a snapshot taken at
construction would serve the old table until something restarted it.

## Secrets are never persisted

A route may carry a credential. The header's **name** is configuration and is
saved; the header's **value** lives in memory and is merged per request.

`StoredRoute` has no field a value fits in, and `save()` **throws** rather than
dropping one quietly — a silent drop means a route that worked before a reload
and 401s after it. `assertNoSecrets` is exported so an adapter written
elsewhere enforces the same rule instead of inventing its own idea of what a
secret looks like.

This is not hypothetical: an earlier shape of this API stored a whole `Route`,
and building the proxy page on it would have written bearer keys into
`localStorage` — where they survive a reload, a shared machine, and anyone who
opens devtools.

`load()` returns `undefined` for **never written**, which is not the same as
`[]`. A first visit seeds its defaults; a visit after the operator deleted
every route must not bring them back.

## Hygiene belongs to the URL upstream, not to the table

Two measured rows force the asymmetry:

- Re-issuing to a third party **consumes** the mesh credential. Forwarding it
  handed a mesh token to an upstream that echoed it back.
- Calling a local handler must **not** strip it, because a handler inside the
  mesh still needs the caller's identity.

## Two shipping defects, fixed and pinned

- A **redirecting upstream** was reported as `502 upstream-unreachable`: an
  opaque redirect has status `0`, and constructing a `Response` with it throws
  *inside* the `try`.
- The outbound request carried **no `signal`**, so an aborted caller left the
  upstream call running.

## One row a browser cannot pass

`Via` is a forbidden header name under the Fetch spec — a page may not set it,
and the browser drops it with no error. ADR-0015 has an intermediary announce
itself with `Via`, so that part is unimplementable in a browser-hosted
intermediary. A fact about the platform, not about this code.

## Entry points

| Import | Holds |
|---|---|
| `.` | `routeTable`, `urlUpstream`, `RouteStore`, `assertNoSecrets`, `rehydrate` |
| `./node` | `fileRouteStore(path)` — write-then-rename |
| `./browser` | `localStorageRouteStore(key?)` |

No transport, no crypto, no platform at the root — exposing a service needs
none of them, which is exactly why a proxy **page** and a Node process can
share this package. `tests/boundary.test.ts` asserts it, and the dependency
list is one entry: `@statewalker/httpeers-core`.

**22 tests**, and the twelve scenarios run inside two of them — the suite
asserts that every scenario ran (guarding against an empty list) and that
none failed.
