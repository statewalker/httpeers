# @statewalker/httpeers-relay

## What it is

The circuit relay behind `relay.httpeers.net`: a stock libp2p **Circuit Relay
v2** server over WebSockets, with no application code. It serves no discovery,
is a member of no mesh and holds no directory. Peers that cannot accept inbound
connections (every browser) reserve a slot on it and are reached through it.
Private: it is deployed as a container image and never published. `startRelay`
is also importable, and `httpeers-conformance` uses it to stand up a real relay
in tests.

The word "relay" means two things in httpeers. In the mesh's vocabulary, a
*Relay* is a peer that forwards requests on a third party's behalf, with a
capability and a hop limit. This app is the *libp2p circuit relay*, a transport
component. Only the second is here.

## Layout

| File | What it is |
|---|---|
| `src/main.ts` | the process: reads the environment, starts the relay, writes the bootstrap document |
| `src/relay.ts` | `startRelay({ privateKey, port?, announce? })` — the node itself |
| `src/limits.ts` | the reservation and per-connection limits; the only place they are set |
| `src/addresses.ts` | what it listens on, what it announces, and why announce is required |
| `src/key.ts` | the identity: loaded from a file or seeded, never generated at start |
| `src/bootstrap-doc.ts` | the `/.well-known/httpeers-relay.json` document |
| `src/bootstrap.ts` | `pnpm bootstrap`: writes a new key |
| `Dockerfile` | the image (build context: the repository root) |

## How to run it

Locally, where the bound address is reachable and so no announce list is needed:

1. `pnpm --filter @statewalker/httpeers-relay bootstrap` — writes
   `apps/relay/.httpeers/relay.key` and prints its base64 form. Back it up.
2. `RELAY_REQUIRE_ANNOUNCE=false pnpm --filter @statewalker/httpeers-relay dev`
   — prints `relay peerId: …` and the addresses it listens on.

In production it runs as the image `ghcr.io/statewalker/httpeers-relay`, behind
Caddy, which terminates TLS; see [`deploy/README.md`](../../deploy/README.md).

```sh
docker build -f apps/relay/Dockerfile .    # from the repository root
```

## Why it is the way it is

### It is open, and capped rather than authenticated

Anyone may reserve. Protection is quantitative: `maxReservations: 512`, a 2 h
reservation TTL, and per relayed connection a data limit of **1 GiB** and a
duration limit of **6 hours**.

Circuit Relay v2 is a limited relay by design. A cap bounds the relay's egress
(it spends its own bandwidth carrying traffic between two third parties), keeps
it from being a free general-purpose libp2p proxy, and leaves peers that could
connect directly a reason to upgrade.

### The per-connection limits sit far above real use

libp2p's defaults — 128 KiB and 2 minutes — assume the circuit only carries an
identify exchange and hole-punch coordination. Here it often carries data: NAT
traversal is negotiated per peer pair, so within one mesh some pairs go direct
and others stay on the circuit.

When a budget is spent, libp2p resets the stream. The application sees a
truncated response and **nothing anywhere says why**. A budget a real session
can reach looks like random corruption: a gallery loads its first images and
then every remaining one breaks, while opening one of them in a new tab works
(a new connection gets a new budget). So the ceiling is set far above measured
use — a browser-to-browser gallery moved 63 MB across eighteen concurrent
transfers — and is a guard against a runaway peer, not a budget. If bandwidth
becomes a problem, measure egress first and lower the ceiling to above observed
use.

`applyDefaultLimit` attaches both figures or neither, which is why both are
declared. Declaring one would suggest a ceiling that is not enforced.

### It refuses to start without an announce address

TLS is terminated by the reverse proxy, so the relay speaks plain `ws` on 9090
and must **advertise** `/dns4/relay.httpeers.net/tcp/443/tls/ws`. libp2p
advertises what it listens on unless told otherwise, so without
`RELAY_ANNOUNCE_ADDRS` the relay would start, report healthy and be undialable,
with a symptom pointing at the relay rather than its address. Announce
addresses must not contain `/p2p/`.

### The signing key is the identity, so it is never generated at start

The relay's peerId is embedded in every multiaddr a client dials. A regenerated
key would silently invalidate every client's configuration at once. A missing
key is a startup failure; the key lives on a volume (`/data` in the image),
never in the image or the repository. `RELAY_KEY` seeds an empty volume and is
ignored once a key file exists, so a stale value in a server `.env` cannot
replace a live identity.

### The bootstrap document comes from the node, not from configuration

A peer that knows only `https://relay.httpeers.net` learns what to dial from
`/.well-known/httpeers-relay.json`:

```json
{ "relayAddrs": ["/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3KooW…"] }
```

`relayAddrs` is the same key the mesh's invitation payload uses. The relay does
not serve the file; it writes it to `RELAY_BOOTSTRAP_PATH` at startup and Caddy
serves it. It is generated from `node.getMultiaddrs()`, not from
`RELAY_ANNOUNCE_ADDRS`, so it cannot drift from what the relay actually
advertises; `tests/bootstrap-integration.test.ts` compares the two. The file is
deleted before every start attempt and written once the relay is up, so a
crash-looping relay yields 404 rather than an address that does not answer.

### Clients pin the relay's peerId on first use

This belongs in client code, but it is the security argument:

1. Fetch the document once, over HTTPS.
2. Persist the peerId with the relay URL.
3. Dial the **full** address including `/p2p/`, so Noise verifies the relay on
   every connection.
4. If the published peerId differs from the pinned one, fail loudly. Never
   re-pin silently.

Trust before step 2 is DNS and the CA; after it, equal to a compiled-in peerId.
If first contact is compromised, the client pins the **attacker's** peerId and
rule 4 then fires against the real relay. So a client must also offer a
**human-initiated reset** that forgets the pin, shows both peerIds for
comparison, and is never triggered by anything the relay or the document can
send. A legitimate key rotation needs the same reset; the client cannot tell a
rotated relay from a substituted one.

This is acceptable for a relay because it is not trusted with content:
peer-to-peer Noise runs inside the circuit, and the target peer's id stays in
the dialled address. A substituted relay can deny service and observe traffic
patterns; it cannot read what flows through. The argument does not transfer to
a hub, whose peerId is the mesh identity.

## What will surprise you

- **No announce address:**

  ```
  relay: RELAY_ANNOUNCE_ADDRS is empty.
  relay: behind a TLS-terminating proxy the address this process binds is not the address
  relay: peers can dial, …
  relay: for a local run without a proxy, set RELAY_REQUIRE_ANNOUNCE=false.
  ```

- **No key:** `relay: no signing key found at "<path>".`, followed by the two
  ways to seed one (`pnpm --filter @statewalker/httpeers-relay bootstrap`, or
  `RELAY_KEY=<base64 protobuf>`).
- **Bootstrap directory not writable:** `relay: could not write the bootstrap
  document to "<path>".` The relay stops rather than run healthy with the
  document missing. In the image the process runs as `node`; the volume must
  be owned by it.
- **Truncated transfers with no error** are what a spent per-connection budget
  looks like (see above).

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/httpeers-relay bootstrap` | write a new key to `RELAY_KEY_PATH` and print it as base64 |
| `pnpm --filter @statewalker/httpeers-relay dev` | run from source with `tsx` |
| `pnpm --filter @statewalker/httpeers-relay build` / `start` | compile to `dist/`, run `dist/main.js` |
| `pnpm --filter @statewalker/httpeers-relay test` | the tests (serially; they bind real ports) |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_PORT` | `9090` | the port the relay binds |
| `RELAY_KEY_PATH` | `./.httpeers/relay.key` (`/data/.httpeers/relay.key` in the image) | the identity |
| `RELAY_ANNOUNCE_ADDRS` | none — required | comma-separated multiaddrs peers should dial; no `/p2p/` |
| `RELAY_REQUIRE_ANNOUNCE` | `true` | `false` for a local run with no proxy in front |
| `RELAY_KEY` | none | base64 protobuf key, to seed an empty volume; ignored once a key exists |
| `RELAY_BOOTSTRAP_PATH` | none (`/srv/bootstrap/.well-known/httpeers-relay.json` in the image) | where to write the bootstrap document; unset, none is written |
