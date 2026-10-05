# @statewalker/httpeers-ghost

## What it is

A remote peer's app, rendered as a page that can reach **only that peer**. A
ghost is the mechanism by which an app hosted by one peer is launched from
another: one mount, one reachable peer. The host serves HTML, assets and
endpoints under its own peerId; the viewer renders them; no source code
travels.

## Why it exists

The ordinary edge reads the target peer from the first path segment and
attaches the viewer's membership token to whatever it forwards. That is right
for the viewer's own app and wrong for a foreign one: a page rendered through
it could address *any* peer in the mesh, with the viewer's credentials, by
fetching a different first segment. A ghost renders somebody else's HTML, and
that HTML must not walk the mesh on the viewer's behalf.

## How to use

```sh
pnpm add @statewalker/httpeers-ghost
```

One entry point (`.`), isomorphic, no peer dependencies. Exports `pinnedPeer`,
`contain`, `policyFor`, `frameSandbox` and `PIN_REFUSED`.

- `pinnedPeer(init)` — a `FetchHandler` that forwards only to one peer.
- `contain(handler, { baseUrl, mode })` — wraps HTML responses so root-absolute
  URLs cannot escape the ghost's mount. `mode` is `"none"`, `"csp"` or
  `"sandbox"`.

## Examples

A ghost mounted at `/ghost/` in the viewer, with CSP containment:

```ts
import { contain, pinnedPeer } from "@statewalker/httpeers-ghost";

const ghost = contain(
  pinnedPeer({
    landing: { peerId: hostPeer, appPath: "/app" },
    basePath: "/ghost/",
    token: () => viewerToken,
    remote: (peerId, request) => peer.call(peerId, request),
  }),
  { baseUrl: "http://viewer.example/ghost/", mode: "csp" },
);
```

An untrusted app in an origin of its own (a session origin fed over a
`MessagePort`): the whole origin is the app's, so `basePath` is `/` and
`contain` is not needed.

```ts
const handler = pinnedPeer({
  landing: { peerId: hostPeer, appPath: "/app" },
  basePath: "/",
  token: () => viewerToken,
  remote: (peerId, request) => peer.call(peerId, request),
});
```

## Internals

### The pin has no parameter for "another peer"

`pinnedPeer` never reads a peer id from the request. The peer is supplied once,
at mount time, and the path is data. No string a rendered page can construct
expresses "some other peer", because the parameter does not exist.

A request the pin will not express is refused with **403** and the
`x-httpeers-ghost: pinned` header (`PIN_REFUSED` is the header name), with a
body of `ghost: outside the ghost's mount` or
`ghost: a ghost may reach only <peerId>`. The header lets a caller tell "the
page tried to leave its mount" from "the host has no such page". A path that
looks like it addresses another peer is refused rather than forwarded as a
path, so the attempt is visible.

### A root-absolute URL escapes the pin, so `contain` exists

`/static/app.css`, fetched from inside a rendered host page, resolves against
the **viewer's** origin, silently. `<base href>` does not help: it governs
relative URLs only. "Host apps must use relative URLs" is not a mechanism,
because nothing enforces it. `contain` applies one of two mechanisms to the
responses the ghost already controls, so neither needs the host app's
cooperation, DNS or TLS:

| `mode` | What it does |
|---|---|
| `"none"` | no containment; the baseline the other two are tested against |
| `"csp"` | a **path-scoped** Content-Security-Policy on the ghost's own HTML responses |
| `"sandbox"` | a sandboxed iframe without `allow-same-origin`, giving the document an opaque origin |

Only HTML is wrapped, because a CSP governs a document and an opaque origin
applies to one. Non-HTML responses get CORS headers instead: under `sandbox`
every fetch the document makes, including one back through the ghost's own
mount, is cross-origin, and without CORS the host app's legitimate traffic
would break. `policyFor` and `frameSandbox` return the exact policy so a caller
can inspect or reuse it.

### `contain` is not a boundary against a hostile app

Under `csp` the ghost document is **same-origin with the viewer**. A hostile
host app can read the viewer's `localStorage`, enumerate the IndexedDB that
holds the identity key and rewrite the viewer's DOM; a CSP governs where a
document may *fetch*, not what same-origin script may *touch*. `csp` contains a
trusted app's accidental escape, not an untrusted app.

**For an app you do not trust, give it an origin of its own.** Each
`<name>.p.httpeers.net` is an empty session origin that a viewer feeds over a
`MessagePort` (see `apps/session-shell`). Use `pinnedPeer` as that port's
handler with `basePath: "/"` and skip `contain`: in its own origin a
root-absolute URL is the session's own path. `apps/demos`
(`src/shared/session-frame.ts`) is the worked example.

### Request bodies are forwarded in Firefox too

Firefox has no `Request.prototype.body`, so a forwarder that passes
`request.body` sends every POST with no body, silently. `pinnedPeer` uses
`bodyOf` from `@statewalker/httpeers-core`, which streams where it can and reads
the body whole where it cannot. A test hides the property to stand in for
Firefox.

### Dependencies

One: `@statewalker/httpeers-core`. `remote` and `token` are callbacks, so the
package neither dials nor knows what a token is; `tests/boundary.test.ts`
asserts it.

Tests: `pnpm --filter @statewalker/httpeers-ghost test`. `tests/contain.test.ts`
drives a host app fixture (`tests/host-app.ts`) through all three modes against
the same escape.

## License

MIT
