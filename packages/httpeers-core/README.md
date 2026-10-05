# @statewalker/httpeers-core

## What it is

The httpeers handler contract and the pieces every other httpeers package
shares: `FetchHandler = (Request) => Promise<Response>`, the mount router, the
headers that carry a caller's proven identity and membership token, the store
interfaces, the peer-call error taxonomy and a monotonic clock. It has no
runtime dependencies and runs in Node, Deno, Bun, browsers and workers.

## Why it exists

Every httpeers package speaks the same contract: a hub, a member, a ghost page
and an edge all route `Request`s to `FetchHandler`s and must agree on where the
caller's identity lives. Those names have to be defined once, in a package
that every runtime can load, so that none of them depends on libp2p, a token
engine or a DOM just to share a type. This package is that place.

## How to use

```sh
pnpm add @statewalker/httpeers-core
```

One entry point (`.`), no peer dependencies.

Your `tsconfig.json` must provide the WinterCG globals (`Request`, `Response`,
`Headers`, `URL`, `AbortController`). The package does not redeclare them,
because a redeclaration collides with the real ones in every project that has
them. Use one of:

- `"types": ["node"]` — Node, Deno or Bun;
- `"lib": [..., "DOM"]` — a browser or worker;
- an equivalent, such as `@cloudflare/workers-types`.

With neither, the `.d.ts` files fail with `Cannot find name 'Request'`.
`tests/consumer.test.ts` compiles a real dependent under each shape.

| Module | What it gives |
|---|---|
| `types` | `FetchHandler`, `PeerIdStr`, `MeshClaims`, `Remote`, the store interfaces, `json()` |
| `router` | `createMounts` (longest-prefix mount table), `createPeerRouter` (`/{peerId}/…` routing) |
| `peer-context` | the proven-peer header, the membership-token header, `forwardLocalOnly`, the claims cache |
| `errors` | `PeerCallError` and its subclasses, each with a stable `kind` |
| `clock` | `createMonotonicClock` — a strictly increasing millisecond clock |
| `http-body` | `bodyOf` — a request's body for forwarding |

## Examples

A mount table:

```ts
import { createMounts, json } from "@statewalker/httpeers-core";

const mounts = createMounts();
mounts.provide("/hello", async () => json({ hello: "world" }));

const handler = mounts.match("/hello/x"); // longest prefix wins; null if none
const res = await handler?.(new Request("http://local/hello/x"));
```

A peer router that serves local mounts and forwards `/{peerId}/…` only for
requests that originated at this peer's own edge:

```ts
import { createPeerRouter, forwardLocalOnly } from "@statewalker/httpeers-core";

const route = createPeerRouter({
  selfPeerId,
  mounts,
  remote: (peerId, req) => peer.call(peerId, req),
  allowForward: forwardLocalOnly,
});
```

Binding identity at an ingress, and reading it in a handler:

```ts
import { lookupPeer, registerPeer } from "@statewalker/httpeers-core";

registerPeer(req, provenPeerId);      // strip any caller-sent value, then write
const who = lookupPeer(req);          // PeerIdStr | ANONYMOUS | undefined
```

The membership token:

```ts
import { readMeshToken, setMeshToken } from "@statewalker/httpeers-core";

setMeshToken(req.headers, token);
const t = readMeshToken(req);         // string, or null when absent or empty
```

Handling a failed peer call by kind:

```ts
import { PeerCallError } from "@statewalker/httpeers-core";

try {
  await remote(peerId, req);
} catch (e) {
  if (e instanceof PeerCallError && e.kind === "peer-unreachable") retryLater();
  else throw e;
}
```

The kinds are `peer-unreachable`, `protocol-unsupported`, `stream-reset`,
`relay-limit-exceeded`, `limited-connection`, `request-timeout` and `unknown`.

## Internals

### Proven identity is a header, so every ingress strips it

`x-httpeers-peer` (`PEER_ID_HEADER`) carries the peer the **transport**
proved. A header survives a re-created `Request` — and handlers re-create
requests all the time — and it is inspectable, which lets the security
property be tested in plain HTTP. A side table keyed by the `Request` object
would be unforgeable but would lose the binding at the first `new Request(old)`,
and third-party middleware could not know to carry it over.

The cost is that a header is whatever the caller typed. So the only functions
that write it strip first:

| Function | What it does |
|---|---|
| `registerPeer(req, peer)` | strip, then write what the transport proved |
| `registerAnonymous(req)` | strip, then write "proven to be nobody" |
| `stripPeerBinding(req)` | strip and assert nothing — a **local** ingress |

Every entry point calls exactly one of them. An ingress that forgets is a
forgery hole, so each adapter tests its own ingress.

`ANONYMOUS` is a `Symbol.for`, with a wire spelling (`ANONYMOUS_HEADER_VALUE`)
that no peerId can collide with.

### The membership token has its own header, and `Authorization` is the application's

`MESH_TOKEN_HEADER` (`x-httpeers-token`) carries the bare membership token, with
no `Bearer ` scheme. `Authorization` passes through the mesh untouched: it
belongs to the application a request is addressed to, for example an LLM
gateway's API key. If both used `Authorization`, the edge would not overwrite a
page's own value, no token would be attached, and the hub would refuse the
application's key as `malformed-token`.

`MESH_CREDENTIAL_HEADERS` lists the token and the proven-peer header: what a
request **leaving** the mesh must not carry. A proxy that re-issues a request
outside the mesh strips exactly that list, never `Authorization`.

### `createPeerRouter` refuses to relay unless told otherwise

Forwarding `/{peerId}/…` to a third party is denied by default. Without that,
any peer could make this one dial a stranger and pump a stream on its behalf.
The hole would be invisible, because it fails closed at the far end: the third
party rejects the tokenless request, so every observable outcome looks right.
The damage is the work done, not the answer given.

Every assembly with a **local edge** needs the same policy — forward what
originated here, never what arrived from the network — so it is a named export,
`forwardLocalOnly`. It treats "no binding" (`lookupPeer(req) === undefined`) as
local, because our own edge strips the header before dispatching. `ANONYMOUS`
is **not** absence: it means the transport proved there was no identity, which
is still "arrived from the network". Reading it as absence would turn the peer
into an open relay. `tests/forward-policy.test.ts` pins that case.

A router without the policy refuses with
`403 {"error":"this peer does not relay for you"}` — from the caller's **own**
router, which is easy to misread as the far peer refusing.

### `bodyOf` exists because Firefox has no `Request.body`

Firefox has no `Request.prototype.body`, so forwarding `request.body` there
sends every POST on with no body, silently. `bodyOf` returns the stream where
the runtime has one and reads the body whole where it does not. Every place
that rebuilds a `Request` to forward it uses this one function.

### What may live here is constrained by the runtime, chosen by change

Being isomorphic is a constraint on this package, not a reason to put code
here. Revocation changes with the deny-list format and lives in
`@statewalker/httpeers-access`; the registries change with membership and live
in `@statewalker/httpeers-hub`. Only the store **interfaces** are here, because
the type is produced by one package and consumed by another that must not
depend on it. Nothing here decides access or speaks a protocol.

### Dependencies

None at runtime. The package imports no `libp2p`, no token engine, no `node:`
builtin and no DOM-only global. `tests/boundary.test.ts` enforces this.

Tests: `pnpm --filter @statewalker/httpeers-core test`.

## License

MIT
