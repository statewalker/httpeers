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
`@libp2p/webrtc` needs the native `node-datachannel` module, whose binary comes
from the optional `@node-datachannel/<platform>` package: keep optional
dependencies on (see the repository root README). This package depends on
`node-datachannel` `^0.33.6` (libdatachannel 0.24.6). WebRTC dials are made
once, and older releases lose a DTLS startup race on the offerer under CPU
load. `@libp2p/webrtc` itself accepts `^0.33.4`, so if your lockfile gives it an
older copy, add a pnpm override. `warnIfOldLibdatachannel()` from `./node`
warns once when the loaded copy is too old.

| Import | Gives | Runs in |
|---|---|---|
| `.` | `createNode`, `servePeer`, identity (`generateKey`, `peerIdOf`, `signerOf`, `identityStore`), reachability, duplex | Node and browsers |
| `./node` | `nodeTransports()` (TCP), `fileBytesStore`, `warnIfOldLibdatachannel` | Node only (`@libp2p/tcp`, `node:fs`) |
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

By default every exchange with a peer rides one windowed mux per peer (issue
#56; see "One mux per peer" below). Tune it, or opt out to one libp2p stream
per exchange:

```ts
const remote = createRemote({ node, muxPerPeer: { window: 4 * 1024 * 1024 } });
// one stream per exchange, as before #56:
const peer = await servePeer({ node, mounts, muxPerPeer: false });
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

### A busy connection is not killed for a slow ping

libp2p's own connection monitor aborts a connection whenever one of its
10-second pings times out (after at least 5 s). Under a bulk transfer on a slow
or lossy link the ping waits behind the queued data, and the healthy
connection dies with every exchange on it. `createNode` therefore replaces it
with `connectionLiveness()`: the same ping, but a failed ping aborts the
connection only when nothing was received on it since the ping was sent.
Each connection learns its own timeout, from answered pings only. A peer that
vanishes silently is still dropped within the interval plus the timeout
(about 15 s by default), or within two intervals plus the timeout (about
25 s) while the node is receiving at least 64 KiB elsewhere, which is read as
a congested shared link. Those bounds assume the connection's learned timeout
is no longer than the interval; on a slow link where it has grown past the
interval, the worst case approaches two intervals plus twice the timeout. Bytes are seen on the raw transport connection (TCP,
WebSockets, relayed circuits) or through `getStats()` (WebRTC). Tune it with
`connectionMonitor` (`pingIntervalMs`, `pingTimeout`, `abortOnPingFailure`,
`silentFailuresWhenBusy`), or pass `false` for no monitor.

What it does not fix: an IDLE connection that shares a congested access link
with a busy one, such as a member's relay or hub reservation while the member
downloads from another peer, receives nothing while its pings wait in the same
queue. The congestion rule gives it one more interval; a queue that delays its
pings past two intervals still aborts it and the reservation has to be made
again. `apps/relay` builds its node without this package and still runs
libp2p's monitor, so a relay aborts such a connection after one slow ping
(5 s or more). A node built by hand with `createLibp2p` gets the same with
`connectionMonitor: { enabled: false }` and
`services: { [CONNECTION_LIVENESS_SERVICE]: connectionLiveness() }`.

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

### One mux per peer (the default)

Every HTTP exchange with a peer is a virtual port of one `multiplexPort`
(`@statewalker/webrun-rpc`) over ONE libp2p stream per peer, on its own
protocol, `/httpeers/1.0.0/mux` (`muxProtocolOf(protocol)` for another fetch
protocol). Each port has a window (`window`, default 256 KiB) and large
messages are framed (`frameSize`, default 31 KiB), so:

- a reader that stops reading holds its own port's window and nothing else:
  the producer stops instead of the receiving peer buffering without limit,
  and other exchanges on the same peer are not delayed behind it;
- when the stream or its connection dies, every exchange open on it fails at
  once with `PeerStreamResetError` (the same error a reset stream gives), and
  the next call opens a new mux;
- one stream per peer, so libp2p's per-protocol and per-connection stream
  caps no longer limit how many exchanges a peer may have open.

`muxPerPeer` (on `servePeer`, `createRemote` and `serveTransport`) is on when
unset or `true`; `MuxPerPeerOptions` tunes it; **`muxPerPeer: false` opts
out** to one libp2p stream per exchange, the path before #56. That path is
`webrun-streams-libp2p`'s `connect`/`serve`: since its 0.7 each exchange is a
port of its windowed native-port mux (`/httpeers/1.0.0/ports/window`, a 4 MiB
window), falling back to its deprecated protocol on `/httpeers/1.0.0` itself
against peers on httpeers-libp2p 0.5 and older (answered on both ends).

**Why it is the default.** Measured on a real link (residential broadband to
a datacenter, about 11 ms RTT, both paths over direct TCP;
[#56](https://github.com/statewalker/httpeers/issues/56#issuecomment-6897312101)):

| | stream per exchange | mux per peer |
|---|---|---|
| Ping p50 / p99, idle (ms) | 20.3 / 55.2 | 12.5 / 23.4 |
| 256 B exchanges/s, K = 1 / 10 / 100 | 48 / 241 / 322 | 74 / 422 / 730 |
| 256 B messages/s on K echo exchanges, K = 100 | 1060 | 2785 |

An exchange takes one round trip on the mux and two on its own stream (each
new stream costs one), so small exchanges run 1.5–2.3× as fast. Beside a bulk
download, a request on the mux waits a few round trips (24.5 ms p50 there);
on its own stream it queues behind the download's bytes (0.3–0.7 s on an
emulated link like that one, #123). The emulated profiles in
[`docs/mux-per-peer-network-bench.md`](docs/mux-per-peer-network-bench.md)
(LAN to 3% loss, TCP and Node↔Node WebRTC) agree, and the per-exchange path
failed most WebRTC runs.

**What it costs.**
- **Bulk on high bandwidth-delay links.** The window bounds one exchange's
  throughput to about window ÷ RTT: the default 256 KiB caps bulk at about
  72% on a 1 Gbit LAN and 19% on a 100 Mbit, 100 ms path (emulated), where a
  stream per exchange fills the link. A larger `window` lifts the cap and
  gives back some of the isolation. An adaptive window is the follow-up.
- **CPU on loopback.** With no latency to save, framing costs: 256 B messages
  on long-lived exchanges run at 60–97% of the per-exchange rate on loopback,
  and one bulk exchange at about 55% with the default window.

`scripts/bench-mux.mjs` compares the two paths (`pnpm build` first; not run in
CI; `--path`/`--cases` to profile a part): on loopback by default, or across
two hosts (`--serve --listen` on one, `--peer` on the other).
`scripts/bench-mux-net.mjs` runs both on an emulated network.

Frames posted in the same task leave as one write (up to one Noise message),
so a burst of small messages, or a run of bulk frames, costs one yamux frame,
one encryption and one socket write rather than one each. The first frame
since the last flush is never held back.

**Compatibility (the fallback).** A peer on the mux SERVES both protocols, so
callers that opted out, or run a version from before the mux, are served as
before. A caller on the mux whose peer does not speak the mux protocol (an
older version, or `muxPerPeer: false`) falls back to a stream per exchange for
that peer's current connection, so old and new peers interoperate both ways;
`muxPerPeer: { fallback: false }` fails such calls with
`PeerProtocolUnsupportedError` instead.

**Serving-side bounds.** The per-exchange path's contract
(`DEFAULT_MAX_STREAMS` × `DEFAULT_DRAIN_TIMEOUT_MS`) carries over. (Every
serving side also serves one stream per exchange, on
`/httpeers/1.0.0/ports/window` and the deprecated `/httpeers/1.0.0`, through
`webrun-streams-libp2p`. From its 0.7.1, which the catalog requires
(statewalker/webrun-wire#195), a caller there that stops reading holds about
one window on the server, the server's own 4 MiB whatever the caller
announces, plus one frame, and a write blocked on the stream's drain for
`drainTimeoutMs` (15 s) drops the exchange. A caller whose transport took the
whole window before it stopped leaves the server waiting for credit instead,
which is not timed: that exchange stays parked, holding about a chunk on the
server, until the caller reads, cancels or disconnects;
`tests/stalled-port-caller.test.ts`.)

- at most `maxInboundStreams` (512) exchanges are served at once per
  connection, counted across all of its muxes; a port past that is refused
  and the caller gets `PeerStreamResetError`, as for a refused stream;
- a served exchange whose response write stays blocked on the caller (no
  window credit) for `drainTimeoutMs` (15 s) is dropped and its port freed,
  so a peer that opens ports and withholds credit pins nothing past it. As on
  the per-exchange path, only a blocked write counts: a quiet exchange (a slow
  response head, an event stream between events, an idle tunnel) is never
  dropped for its silence. Two qualifications. For about one round trip after
  a port opens, until the caller answers the window handshake, a write waits
  for the caller to READ it rather than for credit, so a caller that reads
  nothing for `drainTimeoutMs` right at the start of a response is dropped.
  And a caller that never answers the handshake can only free the port by
  closing it, so the serving side closes such a port itself `drainTimeoutMs`
  after the response has ended. A caller that did answer may read a finished
  response as late as it likes;
- stream chunks are split to `frameSize`, a message on the stream may be at
  most `frameSize` + 16 KiB (`maxMessageBytes`; larger aborts the stream),
  and reassembly past the windows is capped at one window
  (`maxReassembledBytes`);
- a keepalive (every 5 s, `keepaliveMs`) closes a mux whose peer stops
  answering;
- at most 8 mux streams per connection and direction
  (`MUX_MAX_STREAMS_PER_CONNECTION`); a link that finds them all taken uses a
  stream per exchange instead.

**Lifetime.** The mux is opened lazily by the first call to a peer; calls made
while it opens share the one dial. One mux per peer per link and direction:
calls this peer makes ride the mux it opened, calls the peer makes ride the one
the peer opened, and each `createRemote` holds its own. `servePeer`'s `stop()`
closes its muxes, and stopping the node closes their streams. Identity is
unchanged: the serving side takes the Noise-proven peer of the connection the
mux arrived on, never anything a port carries.

**Selecting it.** Only the option does: the library reads no environment.
`startMember` (`@statewalker/httpeers-member`) forwards `muxPerPeer` to its
`servePeer`, and the hub daemon reads `HUB_MUX_PER_PEER` (`off` opts out).
The suites run both paths: this package's transport tests and
`httpeers-conformance` in vitest projects `mux-per-peer` (the option unset:
the default) and `per-exchange` (`muxPerPeer: false`), and
`httpeers-browser-conformance`'s `test:forwarded-body` in each browser on
both.

**Loaded on demand, no longer split out.** `@statewalker/webrun-rpc` and
`@statewalker/webrun-msgpack` are imported dynamically the first time a mux
link is used. Since `webrun-streams-libp2p` 0.7, whose `connect`/`serve` run on
them, they load with it anyway, so a consumer that opts out loads them too.

### Dependencies

libp2p (`libp2p`, `@libp2p/*`, `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`,
`@multiformats/multiaddr`), `@statewalker/httpeers-core`,
`@statewalker/httpeers-bridge` (HTTP over the link), and
`@statewalker/webrun-streams`, `@statewalker/webrun-streams-libp2p`,
`@statewalker/webrun-http-streams` (duplex streams over libp2p), and
`@statewalker/webrun-rpc`, `@statewalker/webrun-msgpack` (the mux).

Tests: `pnpm --filter @statewalker/httpeers-libp2p test`. Files run serially
because they start real libp2p nodes, and the transport tests run twice, once
per exchange path (`tests/exchange-path.test.ts` checks each run uses the path it
names; `tests/mux-link.test.ts` covers what only the mux promises). `tests/serve-peer.test.ts` stands up two
nodes over a real Noise handshake and checks that what arrives carries the
identity the transport proved, not what the caller said.

## License

MIT
