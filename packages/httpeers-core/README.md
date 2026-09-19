# @statewalker/httpeers-core

The httpeers handler contract, mount router, peer context, stores and errors.

**One implementation, every runtime.** This package has no runtime dependencies
and imports no `libp2p`, no `@biscuit-auth/*`, no `node:` builtin and no
DOM-only global. It is built on WinterCG globals — `Request`, `Response`,
`Headers`, `URL`, `AbortController` — which exist in Node, Deno, Bun, browsers
and workers alike.

That boundary is enforced by `tests/boundary.test.ts`, not by convention. The
package this code was extracted from stated the same rule in a comment and
named a `grep` that proved it; the grep had been failing for some time, because
a second file started importing `@libp2p/*` and nobody re-ran it. An invariant
nobody runs is a wish.

## What your project must declare

The package is built on WinterCG globals and does **not** redeclare them —
doing so would collide with the real declarations in every project that has
them. So your `tsconfig.json` needs one of:

- `"types": ["node"]` — a Node, Deno or Bun project;
- `"lib": [..., "DOM"]` — a browser or worker project;
- any equivalent (`@cloudflare/workers-types`, and so on).

With neither, our `.d.ts` files report `Cannot find name 'Request'`.
`tests/consumer.test.ts` compiles a real dependent under each shape, so this
is a tested requirement rather than a note.

## What is here

| Module | What it is |
|---|---|
| `types` | `FetchHandler`, `PeerIdStr`, `MeshClaims`, the store **interfaces**, `json()` |
| `router` | The mount table: longest-prefix matching, and `/{peerId}/…` peer routing |
| `peer-context` | The proven-peer HEADER (`x-httpeers-peer`), the membership-token header (`x-httpeers-token`), `forwardLocalOnly`, and the claims cache |
| `errors` | The peer-call error taxonomy, each with a stable `kind` discriminant |
| `clock` | A strictly-increasing millisecond clock |

Five modules, and the count is deliberate. An earlier cut of this package also
held the revocation cache, the binding middleware and the hub's three
registries — all of them platform-free, which is the wrong test. Being
isomorphic is a *constraint* on what may live here, not a *definition* of what
should: a package is a set of code that changes together. Revocation changes
when the deny-list format does, and belongs with the tokens it filters; the
registries change when membership does, and belong to the hub.

The store **interfaces** stay because the type is produced by one package and
consumed by another that must not depend on it.

## The membership token has its own header

`MESH_TOKEN_HEADER` (`x-httpeers-token`) carries the bare membership token — no
`Bearer ` scheme. `setMeshToken` writes it, `readMeshToken` reads it (an empty
value is no token), and `MESH_CREDENTIAL_HEADERS` lists it with the proven-peer
header as what a request **leaving** the mesh must not carry — the strip list a
proxy passes to `urlUpstream`.

It is **not** `Authorization`. That header belongs to the application a request
is addressed to: a page calling LiteLLM through the mesh puts LiteLLM's key
there. While the token lived in the same header the two collided — the edge will
not overwrite a page's own value, so no token was attached, and the provider
refused the application's key as `malformed-token`. Every writer and the one
reader import the name from here; nothing else spells it.

## Proven identity is a header

`x-httpeers-peer` carries the peer the **transport** proved — not a `WeakMap`,
which is what it used to be.

The WeakMap was unforgeable but did not survive a re-created `Request`, and
re-creating one is what handlers do: seven places in these packages build a new
`Request` from an old one, and exactly **one** carried the binding across. The
rest were outbound-by-design, so it was correct by author discipline, with no
test guarding it and no way for third-party middleware — a Hono router, your
own wrapper — to know the rule existed.

A header survives all of it for free and is inspectable, which is what lets the
security property be tested in plain HTTP. The cost is that a header is
whatever the caller typed, so **stripping is the only way to write one**:

| | |
|---|---|
| `registerPeer(req, peer)` | strip, then write what the transport proved |
| `registerAnonymous(req)` | strip, then write "proven to be nobody" |
| `stripPeerBinding(req)` | strip and assert nothing — a **local** ingress |

Every entry point calls exactly one. A path that forgets is the forgery hole,
so each adapter tests its own ingress rather than trusting a note.

`ANONYMOUS` is a `Symbol.for`, so it has a wire spelling
(`ANONYMOUS_HEADER_VALUE`) that no peerId can collide with. `ProvenPeer` is
unchanged in memory: only the encoding is new.

## `forwardLocalOnly`, and why it is named here

`createPeerRouter` refuses to forward to a third party unless the caller
supplies a policy. That default is right — relaying is its own capability, and
without it any peer can make this one dial a stranger and pump a stream on its
behalf. The hole is invisible for a while because it fails *closed* at the far
end: the third party rejects the tokenless request, so every observable outcome
looks correct. The damage is the work done, not the answer given.

But every assembly that mounts a **local edge** needs the same policy — forward
what originated here, never what arrived from the network — and one of them
re-derived it by omission. `startMember` passed no policy at all, so a member
could not call another member through its own edge, and no type checker could
see it. So the policy is a named export rather than an exercise:

```ts
createPeerRouter({ selfPeerId, mounts, remote, allowForward: forwardLocalOnly });
```

`undefined` from `lookupPeer` means no binding was made — the request carries
no proven-peer header, so it originated at our own edge (which strips one
before dispatching). `ANONYMOUS` is **not**
absence: it means the transport proved there was no identity, which is still
"arrived from the network". Reading the sentinel as absence would turn the peer
into an open relay, so the check is against `undefined` and nothing else, and
`tests/forward-policy.test.ts` pins that case by name.

## What is deliberately NOT here

**Anything that decides.** Tokens, policy, revocation and the access middleware
are `@statewalker/httpeers-access`. The registries they guard are
`@statewalker/httpeers-hub`.

**Transport.** Nothing here dials, listens or speaks a protocol.

---

**57 tests.** No runtime dependencies.
