# @statewalker/httpeers-conformance

Every prototype in the ladder, rebuilt against the **published** API of the eight packages, and
compiled. `tests/consumers.ts` is never executed — a missing export, a narrowed parameter or a type
that moved surfaces here as a compile failure rather than in wave 5.

Private. Never published, and nothing depends on it.

## Why this is its own package

It used to live in `httpeers-core/tests/prototypes/`, which made `httpeers-core` devDepend on all
seven siblings — and every one of them depends on core. pnpm tolerates a devDependency cycle;
**turbo does not**, and refused to run any task across the workspace:

```
x Cyclic dependency detected:
| @statewalker/httpeers-access#build, @statewalker/httpeers-libp2p#build,
| @statewalker/httpeers-member#build, ... @statewalker/httpeers-core#build
```

A check that depends on everything has to be a **leaf**. Here it is one: it devDepends on every
published package (the eight above, plus `httpeers-ghost` and the join widget `httpeers-join`)
and nothing depends on it, so the graph is acyclic and `turbo test` works again.

**To reverse:** move `tests/` back under `httpeers-core`, restore the seven `workspace:*`
devDependencies there, and delete this directory. The cycle comes back with it.

## Four checks, and they answer different questions

| File | Question | Found |
|---|---|---|
| `tests/consumers.ts` | Can every prototype be **expressed**? | `createGateway`, the duplex altitude, `guardStream` — three capabilities with no home |
| `tests/exports.test.ts` | Does every published entry **resolve** for a dependent? | — (guards 20 entries across 8 packages) |
| `tests/runtime-import.test.ts` | Does every isomorphic entry **import**? | `httpeers-member/node` threw on import, green across 637 type-checked tests |
| `tests/mesh.test.ts` | Do the packages **work together**? | a member could not call a member; authorization was load-dependent |

`consumers.ts` is compiled, never executed. `exports.test.ts` enumerates the
`exports` maps themselves and compiles `import * as ns` against each under
`NodeNext` — the only resolution mode that honours an `exports` map, and for a
subpath there is no legacy `types` field to fall back to. `runtime-import.test.ts`
actually `import()`s each one, excluding `./browser` by name and asserting the
exclusion excluded something.

**`mesh.test.ts` stands up the deployment shape with nothing stubbed**: a
Circuit Relay v2 server, a hub that reserves through it and relays for its own
members, and members that redeem invitations and call each other. It is the
extraction's acceptance at runtime, and it found two defects in its first hour
that every compile check had passed. The same harness runs the relay-mode
suites: `relay-fallback.test.ts` (a call over a kept circuit),
`member-relay-fallback.test.ts` (a member whose WebRTC upgrade fails) and
`member-reservation-fallback.test.ts` (a member whose hub has no reservation
slot left — `startMesh({ maxRelayReservations })` — which failed the whole join
in production).

## The lesson these four encode

A compile check and a runtime check are **different claims**, and three real
defects lived in the gap between them. Type-checking an entry point proves
nothing about importing it; importing it proves nothing about two of them
talking to each other.

## What it does not do

Behaviour is still tested in each package, against its own source. This answers
the questions a single package cannot ask about itself.
