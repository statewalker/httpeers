# @statewalker/httpeers-access

## What it is

Who is calling, and may they. Biscuit membership tokens, Datalog rules and
policies, revocation, and **one** middleware — `withAccess` — that puts them in
front of a `FetchHandler`. The Biscuit engine is `@statewalker/webrun-biscuit`,
which is pure TypeScript, so the package runs unchanged in Node, workers,
ServiceWorkers and pages. It has no libp2p in its dependency graph.

## Why it exists

A hub mints a token that states who a peer is and which roles it holds. Every
node that serves something must then answer, for each request: is this token
genuine, is it revoked, and do its roles allow this operation on this
resource? Those answers must be the same everywhere and must not depend on a
transport stack. This package is that decision, kept apart from both the
transport (`@statewalker/httpeers-libp2p`) and the registries
(`@statewalker/httpeers-hub`).

## How to use

```sh
pnpm add @statewalker/httpeers-access
```

No peer dependencies.

| Import | For | Gives |
|---|---|---|
| `.` | a **member** (anything that serves) | `withAccess`, `access`, `verifyToken`, `ruleSet`, `roleNames`, `capabilityNames`, `deriveCapabilities`, `RevocationCache`, `selfCertifyingKeys`, `meshIdOf`, `guardStream`, `LIMITS` |
| `./issuer` | a **hub** | `mintToken`, `generateSigner`, `RevocationRegistry` |
| `./engine` | nobody | `initBiscuit` — deprecated no-op, kept so existing imports compile |

The split is enforced by the import graph: a member that imports the root never
pulls a code path that signs into its bundle.

## Examples

Guard a handler:

```ts
import { access, ruleSet, withAccess } from "@statewalker/httpeers-access";
import { ANONYMOUS, lookupPeer } from "@statewalker/httpeers-core";

const rules = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");'],
  policies: [
    'allow if capability("app:read"), resource("/data")' +
      ' or capability("app:read"), resource($r), $r.starts_with("/data/");',
  ],
});

const guarded = withAccess({
  issuer: hubPeerId,                 // the mesh — and its own verifying key
  rules,
  provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS, // what the transport bound
})(async (req) => {
  const ctx = access(req);           // { peer, claims, capabilities() }
  return Response.json({ caps: [...(ctx?.capabilities() ?? [])] });
});
```

Mint a token on the hub:

```ts
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";

const signer = await generateSigner();   // { mesh, seed }; mesh is the hub's peerId
const token = await mintToken({ signer, sub: memberPeerId, roles: ["member"], ttlMs: 60_000 });
```

Verify one directly:

```ts
import { verifyToken } from "@statewalker/httpeers-access";

const claims = await verifyToken(token, {
  issuer: hubPeerId,
  connectionPeer: provenPeerId,  // what the transport proved; ANONYMOUS fails the token's binding check
}); // throws TokenVerificationError
```

Ask what a rule set grants:

```ts
import { deriveCapabilities, roleNames } from "@statewalker/httpeers-access";

roleNames(rules);                         // ["member"]
deriveCapabilities(rules, ["member"]);    // Set { "app:read" }
```

## Internals

### One middleware, because two could be nested wrong

Token binding and policy have to run in one order: binding reads and verifies
the token and caches the claims; policy reads the cache. Reversed, policy reads
an empty cache and every request looks tokenless. Two separate middlewares
leave that ordering to every caller; `withAccess` takes no ordering parameter
because there is nothing to order. `withPolicy` is exported for the rare caller
that binds the token some other way.

### The token is read from `x-httpeers-token`, never from `Authorization`

`withAccess` reads `MESH_TOKEN_HEADER` (from `@statewalker/httpeers-core`) and
leaves `Authorization` on the request for the handler: that header belongs to
the application. A token sent in `Authorization` is no token. The request is
refused with `401 {"error":"membership token required"}`.

### A peerId is its own verifying key

An Ed25519 peerId is base58btc of an *identity* multihash wrapping a protobuf
`PublicKey`, so the key is recovered by parsing, not looked up.
`selfCertifyingKeys()` does it with `multiformats` alone, and
`tests/self-certifying.test.ts` checks it against libp2p's own answer over real
generated peers. That is why verifying a token needs no libp2p. An RSA peerId
hashes its key, so there is nothing to recover: the resolver returns no keys,
and no keys means **deny**.

### The token carries roles; the node holds the rules

The hub mints identity and role facts. Each node derives capabilities from
roles with its **own** `RuleSet`, built locally and never fetched, so nothing
remote can widen a decision. The node asserts `operation`, `resource`,
`time_ms`, `self_peer` and `connection_peer`; time is in milliseconds
(`time_ms`) because Biscuit's own date terms have one-second resolution.

There is no default rule set. A default that grants no application capability
silently denies every application mounted under it, and it is the first thing
people reach for. `rules` is a required parameter.

### `ruleSet()` refuses to build a policy that would silently deny

A rule naming a predicate that nothing asserts and no rule derives never fires,
and the permanent denial looks exactly like a working policy. So `ruleSet()`
throws `RuleSetError` listing **every** problem:

```
invalid rule set:
  - rules[0]: names predicate 'nope', which nothing asserts and no rule derives -- it can never hold, so this rule is dead
  - policies[0]: names capability 'z', which no rule derives
```

It rejects: text that does not parse; a body predicate nothing supplies; a
policy naming a capability no rule derives; a rule deriving a fact the node or
the token asserts (a forged input); and a policy in `rules` or a rule in
`policies`.

Policies are emitted **deny first**. Biscuit evaluates policies in order and the
first match wins, so a `deny` must beat any `allow` that also matches.

`$r.starts_with("/data")` also matches `/database`. To mean "this resource and
everything under it", write the `or` form used in the example above.

### Timeouts are real, and bounded

`LIMITS` is `{ max_facts: 5000, max_iterations: 200, max_time_micro: 1_000_000 }`.
A `Timeout` from the engine is a measured wall clock, so nothing retries it.
`max_facts` counts work rather than time, so it fires on the same inputs on
every machine and is what bounds a pathological rule set.
`warmUpTokens()` and `./engine`'s `initBiscuit()` are no-ops; the engine needs
no warm-up or loading. Callers can delete those calls.

### Changing a member's roles needs a revocation

A token states its roles until it expires. `RevocationRegistry.changeRoles`
(hub side) records the change so tokens minted before it stop verifying;
`RevocationCache` (member side) holds the hub's list. Without the revocation, a
demoted admin keeps admin for the life of its token.

### Not implemented

Per-device binding (`cnf`), key rotation with an issuer directory, and
delegation. `verifyToken` already takes `keys` (every acceptable key is tried;
the default resolver yields exactly one), so rotation has a seam to arrive
through.

### A token is bound to the connection that presents it

`verifyToken` requires `connectionPeer` — the peer the transport proved — and
asserts it as `connection_peer`, which the token's own check consumes. A token
replayed by another peer fails that check. `ANONYMOUS` asserts nothing and so
fails the binding; there is no permissive default. `selfPeer` is optional: a
verifier that does not state its own id refuses every audience-scoped token and
accepts unscoped ones.

### Dependencies

`@statewalker/httpeers-core` (headers, types), `@statewalker/webrun-biscuit`
(tokens and Datalog), `multiformats` (peerId parsing). No libp2p and no `node:`
builtin; `tests/boundary.test.ts` enforces it.

Tests: `pnpm --filter @statewalker/httpeers-access test`.

## License

MIT
