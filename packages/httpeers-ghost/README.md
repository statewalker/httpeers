# @statewalker/httpeers-ghost

A remote peer's app, rendered as a page that can reach **only that peer**.

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

A ghost is not an application. It is *the mechanism by which an application
hosted by one peer is launched from another*: an invitation, one mount, one
reachable peer. The host serves HTML, assets and endpoints under its own
peerId; the viewer renders them; **no source code travels.**

## Two mechanisms, and both are needed

`pinnedPeer` is the pin. `contain` closes the hole the pin cannot. Neither
replaces the other, and shipping only one leaves the feature unsafe.

### The pin: the peer is not in the request

The stack's ordinary edge dispatch reads the target peer out of the **first
path segment** and attaches the viewer's membership token to whatever it
forwards. A page rendered through that can address *any* peer in the mesh,
with the viewer's credentials, simply by fetching a different first segment.

Correct for the viewer's own app. Wrong for a foreign one — a ghost renders
somebody else's HTML, and that HTML must not be able to walk the mesh on the
viewer's behalf.

So `pinnedPeer` is **not** a wrapper over edge dispatch. It is a different
handler that never reads a peer id from the request at all: the peer is
supplied once, at mount time, and the path is data. There is no string a
rendered page can construct that expresses "some other peer", because the
parameter does not exist.

### The containment: a root-absolute URL escapes anyway

`/static/app.css`, fetched from inside a rendered host page, resolves against
the **viewer's** origin — silently. `<base href>` does not fix it: that governs
relative URLs only.

Three remedies were named. "Host apps must use relative URLs only" is not a
mechanism — nothing enforces it — so it is not implemented. The other two are,
and they are measured against the same escape:

| `mode` | What it does |
|---|---|
| `"none"` | no containment; the baseline the other two are measured against |
| `"csp"` | a **path-scoped** Content-Security-Policy on the ghost's own responses |
| `"sandbox"` | a sandboxed iframe with no `allow-same-origin`, giving the document an opaque origin |

Both are applied by the **ghost**, to responses it already controls. That is
what makes them viable: neither needs cooperation from the host app, and
neither needs DNS or TLS — which is what sank the subdomain option.

Only HTML is wrapped, because a CSP governs a *document* and an opaque origin
applies to one. Non-HTML responses get CORS headers instead: under `sandbox`
the document's origin is opaque, so every fetch it makes — including one back
through the ghost's own mount — is cross-origin. Without that, containment
would also contain the host app's legitimate traffic, which is breakage rather
than containment.

`policyFor` and `frameSandbox` are exported so a caller can inspect or reuse
the exact policy rather than re-deriving it.

## `PIN_REFUSED`

A request the pin will not express comes back **403 with the
`x-httpeers-ghost` header** (`PIN_REFUSED` is that header's name), so a caller
can tell "the rendered page tried to leave its mount" from "the host app has no
such page". A path that *looks* like it addresses another peer is refused
outright rather than forwarded as a path — a foreign page trying exactly that
is the attack this exists to stop, and swallowing it silently would hide the
attempt.

## No transport, no crypto

The dependency list is one entry: `@statewalker/httpeers-core`. `remote` and
`token` are callbacks, so this package neither dials nor knows what a token is,
and `tests/boundary.test.ts` asserts it.

## Tests

**20.** `tests/contain.test.ts` drives a real host app fixture
(`tests/host-app.ts`) through all three modes against the same escape, which is
the only way the comparison means anything — a containment tested against a
different attack from the one that motivated it proves nothing.
