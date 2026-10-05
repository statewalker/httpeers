# @statewalker/httpeers-conformance

## What it is

Private. The checks that no single httpeers package can run on itself: that
every published entry point resolves and imports the way a dependent sees it,
that the reference consumers compile against the published API, that every
library uses the same credential header, and that a relay, a hub and two
members work together with nothing stubbed. It is never published and nothing
depends on it.

## Why it exists

A compile check and a runtime check are different claims. Type-checking an
entry point proves nothing about importing it, and importing it proves nothing
about two of them talking to each other. An entry point can type-check and
still throw on import, and two packages that each pass their own tests can
still fail together — a member unable to call another member, or authorization
that depends on load. These tests close those gaps.

## How to use

```sh
pnpm --filter @statewalker/httpeers-conformance test   # typecheck, then vitest
```

The tests compile and import the built `dist/` of the packages, so build first
(`pnpm build` at the root, or `pnpm turbo build`). The mesh tests bind real
ports and start real libp2p nodes.

## Examples

| File | Question it answers |
|---|---|
| `tests/prototypes.test.ts` + `tests/consumers.ts` | Can the reference consumers be **expressed** on the published API? `consumers.ts` is compiled by `tsc`, never executed. |
| `tests/exports.test.ts` | Does every entry in every `exports` map **resolve** for a dependent? Compiles `import * as ns` against each under `NodeNext`. |
| `tests/runtime-import.test.ts` | Does every isomorphic entry **import** under Node? Excludes `./browser` entries by name and asserts the exclusion matched something. |
| `tests/mesh-credential-header.test.ts` | Does every library use `MESH_TOKEN_HEADER` and none read or write `Authorization`? Only `httpeers-core` may spell the header name. |
| `tests/mesh.test.ts` | Do the packages **work together**? A Circuit Relay v2 server, a hub that reserves through it and relays for its own members, and members that redeem invitations and call each other. |
| `tests/relay-fallback.test.ts` | A call over a kept relay circuit. |
| `tests/member-relay-fallback.test.ts` | A member whose WebRTC upgrade to the hub fails falls back to relay mode. |
| `tests/member-reservation-fallback.test.ts` | A member whose hub has no reservation slot left (`startMesh({ maxRelayReservations })`) falls back to relay mode instead of failing the join. |

## Internals

### It is a leaf, because a check on everything cannot be depended on

It devDepends on every published httpeers package and on the relay app
(`@statewalker/httpeers-relay`, for `startRelay`), and nothing depends on it.
If any package depended on it, the workspace graph would have a cycle, and
turbo refuses to run any task on a cyclic graph:

```
x Cyclic dependency detected:
```

### `NodeNext` is the only resolution that tests a subpath

`Bundler` resolution falls back to the legacy top-level `types` field when an
export condition does not resolve, so it cannot see a broken map. A subpath
(`./node`, `./browser`, `./issuer`) has no such fallback, which is why
`exports.test.ts` compiles under `NodeNext`.

### `mesh-harness.ts` is the deployment shape in one process

`startMesh()` starts a relay (`startRelay`) with a fresh key on port 0, a hub
(`createHub` served with `servePeer`) that reserves on it and relays for its own
members, and member nodes that dial through the relay. The member-fallback
suites run the real `startMember` lifecycle against that hub.
Behaviour of each package is still tested in that package, against its own
source; this harness answers only what the packages cannot ask about
themselves.

## License

MIT
