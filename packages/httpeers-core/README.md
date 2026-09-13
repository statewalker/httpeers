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
| `peer-context` | The `WeakMap<Request, …>` sidecar carrying the transport-proven peer, and `forwardLocalOnly` |
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

`undefined` from `lookupPeer` means no binding was ever made — the request
never passed through an inbound transport handler. `ANONYMOUS` is **not**
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

**45 tests.** No runtime dependencies.
