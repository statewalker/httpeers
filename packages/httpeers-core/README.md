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

## What is here

| Module | What it is |
|---|---|
| `types` | `FetchHandler`, `PeerIdStr`, `MeshClaims`, the store interfaces, `json()` |
| `router` | The mount table: longest-prefix matching, and `/{peerId}/…` peer routing |
| `peer-context` | The `WeakMap<Request, …>` sidecar carrying the transport-proven peer |
| `peer-handlers` | Binding middleware: the claimed subject must equal the proven peer |
| `store` | The hub's three in-memory registries, with an injected clock |
| `revocation` | Pull-and-cache deny list, `iat < changedAt`, no clock sync needed |
| `rule-set` | The rule-set **vocabulary** — the type and its pure readers |
| `errors` | The peer-call error taxonomy, each with a stable `kind` discriminant |
| `clock` | A strictly-increasing millisecond clock |

## What is deliberately NOT here

**The authorizer.** `rule-set` carries the `RuleSet` type and the functions that
*read* one — `roleNames`, `capabilityNames`, `validateRoles` — because those are
pure string work. Building a rule set (`ruleSet()`, which canonicalises through
the Biscuit parser) and evaluating one (`authorize`, `deriveCapabilities`) need
WebAssembly, and live in `@statewalker/httpeers-access`.

The split is what lets `createMemberStore(rules, clock)` validate its roles at
the store — where the durable guard belongs — without dragging a WASM runtime
into every consumer's bundle.

**Transport.** Nothing here dials, listens or speaks a protocol.
