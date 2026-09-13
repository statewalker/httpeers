# @statewalker/httpeers-hub

Minting membership, holding the registries, and saying who is in the mesh.

```ts
import { createHub, memoryStorage } from "@statewalker/httpeers-hub";

const hub = await createHub({
  selfPeerId,                       // this hub's peerId IS the mesh's name
  policies: rules,
  storage: memoryStorage(),
  mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 60_000 }),
});

const invite = await hub.invitations.create(["member"], 60_000);
```

`hub.mounts` is a mount table. Serving it on a wire is somebody else's job.

## A hub has no transport, and that is what lets it run in a tab

This package dials nothing and listens on nothing. `servePeer`
(`@statewalker/httpeers-libp2p`) is what puts the mount table on a wire, and
the dependency list here is `core`, `access` and `hono` — no libp2p, asserted
by `tests/boundary.test.ts`.

That is not tidiness. It is the property that makes a **hub in a browser tab**
possible at all, and it is why the hub's *lifecycle* is deliberately not in
this package: composing a node, a relay reservation, `createHub` and an edge is
application wiring, and both the Node hub and the hub page do it themselves.
`httpeers-conformance` compiles that composition as a consumer, so if the
packages ever stop being sufficient for it, a test says so.

## Invitations are bearer credentials, and are treated as such

An invitation id is **128 bits from the platform CSPRNG**, never `Math.random`:
whoever holds one can become a member. The hub generates it **by default**, so
nobody has to invent unguessable strings — `create(roles, ttlMs)` is the whole
call. A caller may name the id (`{ id }`) for a deployment migrating existing
codes or a test wanting a constant, and that is the only way to get a weak one.

Every mutator resolves when the write is **durable**. A caller is never told
"created" before it is, because an invitation handed out over the phone and
then lost to a crash a millisecond later is an invitation somebody is standing
there holding.

Unredeemed invitations **survive a restart** — they are in the snapshot, not in
memory — and `pending()` lists them so an operator can see what is outstanding.

## The snapshot is synchronous and the storage is not

`SnapshotStore.write` must stay synchronous: `createHubState` calls it and
returns, so an async write would open a window where a caller has been told a
member was added while the snapshot still says otherwise. There is no way to
block on a promise in a browser, so the shape is forced:

**the in-memory copy is authoritative, and the backend trails it.** `write`
replaces `current` and returns; the flush runs behind it on one promise chain.
Reads answer from `current`, so the hub always sees what it last wrote.

The chain matters: writes reach storage **in order**. An unordered
`void put(...)` per write would let a slow earlier write land on top of a later
one and **resurrect a spent invitation id**, which is a membership bypass.
`asyncSnapshotStore` is that wrapper over any `KeyValueStorage`, and
`flushed()` is how a test waits for durability.

Honestly stated: a tab closed between a write and its flush loses that write.
This is a page, not a database.

| Import | Storage |
|---|---|
| `.` | `memoryStorage()`, `filesStorage(files, dir?)` over a `FilesApi` |
| `./node` | `fileStorage(path)` |
| `./browser` | `idbStorage(name?, store?)` — IndexedDB, which is transactional |

`filesStorage` **writes-then-moves**. The prototype's Node persistence wrote in
place, so a crash mid-write left a half-written snapshot where the whole state
lives; this adapter does not inherit that.

## Roles come off the rules, not a second list

There is no separate vocabulary document. A role exists for this mesh exactly
when some rule fires on it, so `roleNames(rules)` is the registry, and both
`members.setRoles` and `invitations.create` validate against it. A role added
to the policy appears everywhere without anyone updating a second place.

## Changing roles takes two writes, or it is a lie

`MemberStore.setRoles` rewrites the record — but the peer is carrying a token
that already states its **old** roles and stays valid until it expires, so a
demoted admin keeps admin for the life of that token. `revocations.changeRoles`
records the change so tokens minted before it stop verifying, which is what
makes the new roles take effect on the peer's next heartbeat.

The store does not do this for you. Both halves, or the change is cosmetic.

## Presence is a heartbeat

A member that stops beating is swept from the mesh view within one TTL, and its
advertisements go with it. `sweep()` is callable directly — which is what a
test with a controlled clock wants — or driven on a timer with
`sweepIntervalMs`.

## Tests

**43, plus 4 skipped** (the platform-entry exemptions in the boundary test).
The hub is also exercised for real in `@statewalker/httpeers-conformance`,
where it mints an invitation that a live member redeems over a relay.
