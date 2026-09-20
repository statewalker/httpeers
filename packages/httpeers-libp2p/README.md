# @statewalker/httpeers-libp2p

The transport: nodes, identity, reachability, and `servePeer` — **the one
package in the extraction that knows what libp2p is.**

```ts
import { createNode, generateKey, servePeer } from "@statewalker/httpeers-libp2p";
import { nodeTransports } from "@statewalker/httpeers-libp2p/node";

const node = await createNode({ privateKey: await generateKey(), transports: nodeTransports() });
const peer = await servePeer({ node, mounts, access: guard });

await peer.call("12D3KooWOther", new Request("http://peer.local/hello"));
```

Everything above this package speaks `FetchHandler` and `Mounts`. Nothing above
it imports `libp2p`.

## `servePeer` is the seam three assemblies collapse into

A hub, a Node member and a page were each wiring a node, a router, an inbound
handler and an outbound dialler by hand. `servePeer` is that arrangement, once:
it owns the wire and the router, and it takes `access` as a parameter rather
than knowing what a token is.

```
servePeer  ──owns──>  the protocol handler, the router, the outbound dialler
           ──takes──> access: (handler) => handler        ← withAccess, from httpeers-access
```

The two never import each other. `httpeers-access` has no transport and this
has no crypto policy; the graph runs `core → access` and `core → libp2p`, and
`tests/boundary.test.ts` fails if either starts pointing at the other.

`Peer.dispatch` is exposed deliberately — it is the inbound router *after*
identity binding and policy, which is what lets a local edge reuse the same
decision path instead of building a second one.

## Transports are a parameter, and that was a defect fix

`createNode` **requires** `transports`. The prototype hard-coded `tcp()` inside
its node factory, so importing the transport module at all dragged a Node-only
transport into a browser bundle — in a package whose whole claim was that one
implementation runs on both.

| Import | Holds | Why it cannot be at the root |
|---|---|---|
| `.` | `createNode`, `servePeer`, identity, reachability, duplex | — |
| `./node` | `nodeTransports()` (adds `tcp`), `fileBytesStore` | `@libp2p/tcp` cannot run in a browser; `node:fs` cannot either |
| `./browser` | `browserTransports()`, `idbBytesStore` | IndexedDB |

The root's boundary test asserts `@libp2p/tcp` and `node:` never appear there.
Note what is *not* forbidden: `@libp2p/webrtc` is at the root, because a page
needs it and a Node process can load it too — though only if its native
dependency actually built. See the note on `node-datachannel` at the repository
root.

An explicit export list, never `export *`: the barrel this code came from ended
with `export * from "./transport-duplex.js"`, which is how a package that
documented itself as isomorphic pulled libp2p, TCP, Noise and yamux into every
consumer's bundle.

## Reachability, which is most of what is here

A browser cannot listen for inbound TCP. It reserves a slot on a relay and
accepts an upgrade brokered over it, and the modules here are the steps of
that:

| Module | What it does |
|---|---|
| `reservation` | `dialRelay`, `waitForCircuitReservation`, `circuitAddrs`, `superviseRelay` (+ `reservationHealthy`, `renewalIntervalMs`) |
| `hop-reserve` | `requestRelayReservation` — ask the relay itself, in its own protocol |
| `timers` | the injectable `Timers` seam (`worker-timers` in a background tab) |
| `hub-link` | `reachHub`, `reachHubRelayed`, `reserveOnHub` (+ `HubReservationError`), `leaveRelay`, `superviseHubReservation` |
| `hub-relay` | `hubRelayService`, `membershipGater`, `releaseReservation` — a hub relaying for **its own members and nobody else** |
| `identity` | `generateKey`, `peerIdOf`, `signerOf`, the persisted `identityStore` |
| `duplex` | the second altitude — see below |

**A reservation yields two addresses and only one works.** The bare
`/p2p-circuit` entry is a *limited* connection on which libp2p silently refuses
the protocol; the `/webrtc`-suffixed one is the one to publish. `circuitAddrs`
returns both, labelled, so nobody has to rediscover which is which by pasting
the wrong one.

**Only the relay knows whether you are reserved.** `node.getMultiaddrs()` is
the node's own belief, and on 2026-09-19 a deployed hub held that belief for
hours while the relay held no reservation at all: the websocket was still up,
every member got `NO_RESERVATION`, and the supervisor — which decided from that
address list — saw nothing wrong. So `superviseRelay` asks the relay, on a
schedule derived from the TTL the relay itself granted (`renewalIntervalMs`: a
quarter of it, jittered down into its upper quarter; 22.5–30 minutes against a
two-hour TTL). The request is a circuit-relay v2 `HOP RESERVE` over the
existing connection (`requestRelayReservation`) — libp2p's own `addRelay` short
-circuits on its cached entry, is not reachable from `Libp2p`, and blacklists a
relay locally on failure. Because a relay's reservation store is keyed by peer,
that one request renews an entry that exists and re-creates one that does not,
reusing the slot and leaving live circuits alone.

The address list now proves a **loss** (it is gone) and never proves health (it
is there). `supervisor.state()` carries the whole picture — status,
`verifiedAt`, `expiresAt`, `lostSince`, consecutive failures, renewal and
restore counts, last error — and `reservationHealthy(state)` is the rule a
healthcheck should use: reserved, or lost for less than two minutes. Every
transition logs one line naming the relay and the reason; the old
implementation swallowed all of them.

`scripts/probe-hub.mjs <hubPeerId>` answers the same question from OUTSIDE, as
a member would: it dials `<relay>/p2p-circuit/p2p/<hub>` with an independent
libp2p client and prints one JSON line. Run it from this package's directory so
its dependencies resolve. That probe is how the incident was confirmed to be
real rather than a member-side fault, and it is the check to run first next
time.

**A refused reservation says which refusal it was.** libp2p reports every
failed reservation alike ("Some configured addresses failed to be listened
on"), with the relay's status only in the text. `reserveOnHub` reads it out and
throws a `HubReservationError` with `status` (the circuit-relay status, or
`null`) and `refusal`: `store-full` (`RESERVATION_REFUSED` — the hub's relay
holds as many reservations as it grants), `resource-limit`
(`RESOURCE_LIMIT_EXCEEDED`), `not-a-member` (`PERMISSION_DENIED`), `no-relay`
(the hub runs no relay service), `no-answer` (a timeout or a dropped link) or
`other`. It used to throw one message naming `PERMISSION_DENIED` whatever had
happened, and a full store was diagnosed in production as a membership problem.

**`membershipGater` takes a thunk, not a value.** A hub's node must exist
before the member store that answers "is this a member" does, and the thunk is
read at decision time, which is what closes that ordering cycle.

**A hub's reservation store is sized for a mesh, not for a public relay.**
libp2p's default holds 15 reservations for two hours each and keeps one after
its holder hangs up; a hub on it refused every member with
`RESERVATION_REFUSED` after fifteen distinct peers. `hubRelayService` sizes the
store at `HUB_MAX_RESERVATIONS` (4096; `{ maxReservations }` overrides it),
releases a reservation when its holder's last connection closes, and
`releaseReservation(relay, peerId)` frees a revoked member's slot at once. None
of this touches the per-circuit data limits (128 KiB, 2 min), which are what
keep a hub a signalling channel: the store says how *many* members are
reachable through the hub, not how *much* may cross it.

## `signerOf` — the bridge that stops a mesh naming nobody

A hub signs membership tokens with the same key its node speaks with. Build the
node from one key and mint with another, and every token's `mesh` claim names a
peer nobody is talking to — a failure that looks like a policy bug.

```ts
const signer = signerOf(hubKey);   // { mesh: peerIdOf(hubKey), seed: key.raw.slice(0, 32) }
```

The return type is declared **structurally** rather than imported from
`httpeers-access`, so this package does not depend on it. A mismatch is a
compile error in whichever assembly wires the two together, which is where it
belongs.

## The second altitude: duplex

A fetch-only contract cannot express a WebSocket — both sides talking with
neither input closed. `serveDuplex` / `openDuplex` run one `Duplex` per libp2p
stream, addressed by path through their own mount table, on a separate
protocol. This exists because the requirement did, not because `FetchHandler`
was inconvenient: it is a different shape, so it gets a different seam rather
than a flag.

## Tests

**68, plus 4 skipped** (the platform-entry exemptions in the boundary test).
`tests/hub-link.test.ts` pins how `reserveOnHub` reads each refusal out of
libp2p's error text. `tests/serve-peer.test.ts` stands up two real nodes over a real Noise
handshake and checks that what arrives carries the identity the **transport**
proved rather than anything the caller said.

The whole stack — relay, hub, members, tokens — is exercised together in
`@statewalker/httpeers-conformance`.
