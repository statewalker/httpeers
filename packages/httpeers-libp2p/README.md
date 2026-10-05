# @statewalker/httpeers-libp2p

## What it is

The httpeers transport: libp2p nodes, identity keys, reachability through
circuit relays, and `servePeer`, which puts a mount table on the wire and calls
other peers. It is the only httpeers package that imports libp2p; everything
above it speaks `FetchHandler` and `Mounts`.

## Why it exists

A hub, a Node member and a page all need the same arrangement: a node, a
router, an inbound protocol handler and an outbound dialler — and, for a peer
that cannot accept inbound connections, a relay reservation that stays alive.
Getting reachability right is most of the work (a reservation that silently
lapses makes a peer unreachable with no error anywhere), so it is written once,
here, and every assembly takes it as a library instead of wiring libp2p by hand.

## How to use

```sh
pnpm add @statewalker/httpeers-libp2p
```

libp2p and its transports are regular dependencies. Under Node,
`@libp2p/webrtc` needs the native `node-datachannel` module; with pnpm 10 it
must be listed in `onlyBuiltDependencies`, or pnpm skips its build script and
the import fails at runtime (see the repository root README).

| Import | Gives | Runs in |
|---|---|---|
| `.` | `createNode`, `servePeer`, identity (`generateKey`, `peerIdOf`, `signerOf`, `identityStore`), reachability, duplex | Node and browsers |
| `./node` | `nodeTransports()` (TCP), `fileBytesStore` | Node only (`@libp2p/tcp`, `node:fs`) |
| `./browser` | `browserTransports()` (WebSockets, circuit relay, WebRTC), `idbBytesStore` | browsers (IndexedDB) |

The root never reaches `@libp2p/tcp` or a `node:` builtin; `tests/boundary.test.ts`
asserts it. `@libp2p/webrtc` is at the root because a page needs it and a Node
process can load it too.

## Examples

A Node peer serving a mount table and calling another peer:

```ts
import { createMounts } from "@statewalker/httpeers-core";
import { createNode, generateKey, servePeer } from "@statewalker/httpeers-libp2p";
import { nodeTransports } from "@statewalker/httpeers-libp2p/node";

const node = await createNode({
  privateKey: await generateKey(),
  transports: nodeTransports(),
  listen: ["/ip4/0.0.0.0/tcp/0"],
});
const mounts = createMounts();
const peer = await servePeer({ node, mounts, access: guard }); // guard: e.g. withAccess(...)

const res = await peer.call(otherPeerId, new Request("http://peer.local/hello"));
```

Keeping a relay reservation alive and exposing its health:

```ts
import { reservationHealthy, superviseRelay } from "@statewalker/httpeers-libp2p";

const supervisor = superviseRelay({ node, relayAddr });
const healthy = reservationHealthy(supervisor.state()); // reserved, or lost < 2 min
```

Signing tokens with the node's own key:

```ts
import { signerOf } from "@statewalker/httpeers-libp2p";
import { mintToken } from "@statewalker/httpeers-access/issuer";

const signer = signerOf(hubKey); // { mesh: peerIdOf(hubKey), seed }
const token = await mintToken({ signer, sub, roles: ["member"], ttlMs: 60_000 });
```

## Internals

### `servePeer` owns the wire and takes policy as a parameter

```
servePeer ──owns──>  the protocol handler (/httpeers/1.0.0), the router, the outbound dialler
          ──takes──> access: (handler) => handler      e.g. withAccess from httpeers-access
```

`httpeers-access` has no transport and this package has no access policy; the
graph runs `core → access` and `core → libp2p`, and the boundary test fails if
either points at the other. `Peer.dispatch` is the inbound router *after*
identity binding and policy, so a local edge reuses the same decision path.
Inbound identity comes from the Noise handshake and is bound with
`registerPeer` by `@statewalker/httpeers-bridge`.

### `createNode` requires transports

There is no default transport list. A default containing `tcp()` would drag a
Node-only transport into every browser bundle that imports the root. Pass
`nodeTransports()` or `browserTransports()`; with none, `createNode` throws
`createNode: at least one transport is required. Use \`nodeTransports()\` …`.
The root uses an explicit export list, never `export *`, so nothing Node-only
leaks in through a barrel.

### A browser is reachable only through a relay reservation

A page cannot listen for inbound connections. It reserves a slot on a relay and
accepts a WebRTC upgrade brokered over it:

| Module | What it does |
|---|---|
| `reservation` | `dialRelay`, `waitForCircuitReservation`, `circuitAddrs`, `superviseRelay`, `reservationHealthy`, `renewalIntervalMs` |
| `hop-reserve` | `requestRelayReservation` — a circuit-relay v2 `HOP RESERVE` on the existing connection |
| `timers` | the injectable `Timers` seam (`worker-timers` in a background tab) |
| `hub-link` | `reachHub`, `reachHubRelayed`, `reserveOnHub`, `leaveRelay`, `superviseHubReservation` |
| `hub-relay` | `hubRelayService`, `membershipGater`, `releaseReservation` — a hub relaying for its own members only |
| `identity` | `generateKey`, `peerIdOf`, `signerOf`, `identityStore` |
| `duplex` | `serveDuplex`, `openDuplex`, `createDuplexMounts` — see below |

**A reservation yields two addresses, and only one works.** The bare
`/p2p-circuit` address is a *limited* connection on which libp2p silently
refuses the httpeers protocol; the `/webrtc`-suffixed one is the one to
publish. `circuitAddrs` returns both, labelled.

### Only the relay knows whether you are reserved

`node.getMultiaddrs()` is the node's own belief. A node can keep listing a
circuit address for hours while the relay holds no reservation: the WebSocket
is still up, and every member trying to reach it gets `NO_RESERVATION`. So the
address list proves a **loss** (the address is gone), never health.

`superviseRelay` therefore asks the relay, with a `HOP RESERVE` over the
existing connection, on a schedule derived from the TTL the relay granted
(`renewalIntervalMs`: a quarter of it, jittered down into its upper quarter;
22.5–30 minutes against a two-hour TTL, clamped to 1–30 minutes). libp2p's own
`addRelay` is not usable for this: it short-circuits on its cached entry, is not
reachable from `Libp2p`, and blacklists a relay locally on failure. A relay
keys reservations by peer, so one request renews an entry that exists and
re-creates one that does not, keeping live circuits.

`supervisor.state()` reports status, `verifiedAt`, `expiresAt`, `lostSince`,
consecutive failures, renewal and restore counts and the last error.
`reservationHealthy(state)` is the rule for a health check: reserved, or lost
for less than `RESERVATION_LOSS_GRACE_MS` (2 minutes). Every transition logs one
line naming the relay and the reason.

`scripts/probe-hub.mjs <hubPeerId>` checks reachability from **outside**, as a
member would: it reads the relay address from
`https://relay.httpeers.net/.well-known/httpeers-relay.json`, dials
`<relay>/p2p-circuit/p2p/<hub>` with an independent libp2p client and prints
one JSON line. Run it from this package's directory so its imports resolve.
It is the first check when members report a hub as unreachable.

### A refused hub reservation says which refusal it was

libp2p reports every failed reservation the same way ("Some configured
addresses failed to be listened on"), with the relay's status only in the text.
`reserveOnHub` reads it out and throws `HubReservationError` with `status` and
`refusal`:

| `refusal` | Relay status | Message starts |
|---|---|---|
| `store-full` | `RESERVATION_REFUSED` | `hub-link: the hub (…) refused a reservation with RESERVATION_REFUSED: the hub's reservation store is full` |
| `resource-limit` | `RESOURCE_LIMIT_EXCEEDED` | `… refused a reservation with RESOURCE_LIMIT_EXCEEDED: the hub's relay is at a resource limit.` |
| `not-a-member` | `PERMISSION_DENIED` | `… this peer is not a member as far as the hub is concerned` |
| `no-relay` | — | `… does not relay at all -- it has no circuit-relay service` |
| `no-answer` | — | `… gave no answer to a reservation request.` |
| `other` | any other | `… refused a reservation with <status>.` |

A full store is not a membership problem, and the message says so.
`tests/hub-link.test.ts` pins each case.

### A hub's reservation store is sized for a mesh

libp2p's relay default holds 15 reservations for two hours each and keeps one
after its holder disconnects; a hub on that default refuses every member with
`RESERVATION_REFUSED` after fifteen distinct peers. `hubRelayService` sizes the
store at `HUB_MAX_RESERVATIONS` (4096; `{ maxReservations }` overrides it),
releases a reservation when its holder's last connection closes, and
`releaseReservation(relay, peerId)` frees a revoked member's slot at once. The
per-circuit data limits stay at libp2p's defaults (128 KiB, 2 minutes): they
keep the hub a signalling channel. The store bounds how *many* members are
reachable through the hub, not how *much* may cross it.

`membershipGater` takes a thunk, not a value: the hub's node must exist before
the member store that answers "is this a member", and the thunk is read at
decision time.

### `signerOf` keeps the mesh name and the signing key the same

A hub signs membership tokens with the key its node speaks with. Build the node
from one key and mint with another, and every token's `mesh` claim names a peer
nobody is talking to — which looks like a policy bug. `signerOf(key)` returns
`{ mesh: peerIdOf(key), seed }`. Its return type is declared structurally, so
this package does not depend on `httpeers-access`; a mismatch is a compile error
in the assembly that wires the two together.

### Duplex is a second protocol for a different shape

A fetch contract cannot express a WebSocket: both sides talking, neither input
closed. `serveDuplex` / `openDuplex` run one `Duplex` per libp2p stream on
`/httpeers-duplex/1.0.0`, addressed by path through their own mount table
(`createDuplexMounts`).

### Dependencies

libp2p (`libp2p`, `@libp2p/*`, `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`,
`@multiformats/multiaddr`), `@statewalker/httpeers-core`,
`@statewalker/httpeers-bridge` (HTTP over the link), and
`@statewalker/webrun-streams`, `@statewalker/webrun-streams-libp2p`,
`@statewalker/webrun-http-streams` (duplex streams over libp2p).

Tests: `pnpm --filter @statewalker/httpeers-libp2p test`. Files run serially
because they start real libp2p nodes. `tests/serve-peer.test.ts` stands up two
nodes over a real Noise handshake and checks that what arrives carries the
identity the transport proved, not what the caller said.

## License

MIT
