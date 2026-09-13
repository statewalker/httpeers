# @statewalker/httpeers-relay

The circuit relay, as a process. **Private** — deployed as an image, never published.

A stock libp2p **Circuit Relay v2** server over WebSockets, with **no application code**:
it serves no discovery, announces itself as a member of nothing, and holds no directory.
The one component in the system that is genuinely infrastructure, and also the only one
containing no project logic — that those two facts coincide is the design working.

> **A note on the word.** The domain's *Relay* is a peer that forwards on a third party's
> behalf, an application-level concern with a capability and a hop limit. This is the
> *libp2p circuit relay*, a transport component, and a different thing. Only the second
> is here.

```sh
pnpm --filter @statewalker/httpeers-relay bootstrap   # writes .httpeers/relay.key
RELAY_REQUIRE_ANNOUNCE=false pnpm --filter @statewalker/httpeers-relay dev
```

| Module | What it is |
|---|---|
| `relay.ts` | `startRelay({ privateKey, port?, announce? })` — the node itself |
| `limits.ts` | The per-connection ceilings, and the only place those numbers are set |
| `addresses.ts` | What it listens on, what it announces, and why announce is not optional |
| `key.ts` | The identity, loaded or generated |
| `bootstrap-doc.ts` | The `.well-known` document a peer reads to find this relay |

**`startRelay` is importable, and the test suite uses it that way** — the mesh conformance
suite in `packages/httpeers-conformance` stands up a real relay from this module to join
real members to a real hub.

Operations, the limit reasoning, the announce rules and every environment variable are in
the [repository README](../../README.md) — this app is documented there rather than twice.

**74 tests.**
