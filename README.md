# httpeers

A peer-to-peer mesh where **everything is a `fetch()`**. Two halves live here:

- **`packages/`** — eight libraries a page or a process builds a mesh out of,
  plus a private conformance suite that holds them to it. The reverse proxy
  moved to [`@statewalker/webrun-http-proxy`](https://github.com/statewalker/webrun-wire),
  where nothing about it is mesh-specific.
- **`apps/` and `deploy/`** — the deployable services the mesh needs to exist:
  the circuit relay, the static-site host, the session shell, and the ingress
  that fronts them. Live at `relay.httpeers.net`, `s3.httpeers.net`,
  `*.httpeers.net` and `*.p.httpeers.net`. Also the demo pages that run on them.

**Before building on it, read [`docs/security-model.md`](docs/security-model.md)** —
the mesh mounts every peer's HTTP surface into your own origin and calls it with
your identity automatically, so *data* crosses that boundary safely but *code*
does not. That document defines the valid uses and the ones to avoid, and is the
frame the packages below sit inside.

Design and decisions live in the umbrella repository:
`docs/superpowers/specs/2026-09-06-httpeers-relay-production-design.md`, the
extraction's acceptance record at
`docs/superpowers/plans/2026-09-13-httpeers-extraction-acceptance.md`, and the
mesh's own vocabulary in `docs/httpeers/CONTEXT.md`.

## Layout

```
packages/          the libraries -- see below
apps/relay/        the circuit relay, and its image
apps/sites/        the static-site host -- one site per storage prefix
apps/session-shell/ the empty session every <name>.p.httpeers.net serves
apps/demos/        the demo pages: hub, app, images, proxy
deploy/            the compose stack, the Caddyfile, the ingress image
tools/publish/     shell toolkit: publish a site by editing a folder
.github/workflows/ ci, and one image-publishing workflow per deployable
```

## The libraries

One contract runs through all of them: `FetchHandler = (Request) => Promise<Response>`.
A mount table routes it, a peer serves it over libp2p, an edge lets a page
reach it through its own `fetch()`. Nothing below the transport package knows
what libp2p is.

| Package | What it is |
|---|---|
| [`httpeers-core`](packages/httpeers-core) | The handler contract, the mount router, the peer-context sidecar. **No dependencies at all.** |
| [`httpeers-access`](packages/httpeers-access) | Who is calling, and may they: Biscuit tokens, Datalog policy, revocation, one middleware. No libp2p. |
| [`httpeers-bridge`](packages/httpeers-bridge) | Fetch over a duplex, both directions, with **no transport in it**. `PeerLink` is the seam; `./ports` runs a mesh over `MessageChannel`. |
| [`httpeers-libp2p`](packages/httpeers-libp2p) | The transport — nodes, identity, reachability, `servePeer`. The only package that knows what libp2p is. |
| [`httpeers-hub`](packages/httpeers-hub) | Minting membership and holding the registries. No transport, which is what lets a hub run in a tab. |
| [`httpeers-member`](packages/httpeers-member) | Everything a participant does: `startMember`, the session, the edge, the gateway. |
| [`httpeers-ghost`](packages/httpeers-ghost) | A remote peer's app rendered as a page that can reach only that peer. |
| [`httpeers-qr`](packages/httpeers-qr) | Invitations as QR: pure encode/decode, plus a browser entry that scans from the camera. |
| [`httpeers-conformance`](packages/httpeers-conformance) | Private. Every prototype rebuilt on the published API, every entry point imported, and one real mesh. |

### Two rules the packages are built on

**Proven identity is a header, and every ingress strips it.** `x-httpeers-peer`
carries the peer the *transport* proved. It travels in a header rather than a
side-table so that it survives a re-created `Request` — which is what handlers
do — and so the security property can be tested in plain HTTP. The cost is that
a header is whatever the caller typed, so `registerPeer`, `registerAnonymous`
and `stripPeerBinding` all strip before they write, and every entry point calls
exactly one of them. `httpeers-conformance` proves it over a real libp2p
connection: a peer claiming to be somebody else is overwritten by the handshake.

**Isomorphic by default, platform behind an entry point.** A package's root
runs in Node, in a worker and in a page alike; anything that cannot goes behind
`./node` or `./browser`. Each package's boundary test enforces it — in
`httpeers-member` and `httpeers-qr` by walking the import closure of
`index.ts`, so the rule is "nothing a root import reaches", not "these
filenames are exempt".

**A compile check and a runtime check are different claims.** Three real
defects lived in that gap, including a published entry point that could not be
imported while 637 type-checked tests stayed green. `httpeers-conformance`
closes it: it compiles every entry, imports every isomorphic one, and stands up
a live relay, hub and two members with nothing stubbed.

### Working on them

```sh
pnpm install
pnpm turbo build
pnpm turbo test          # 506 tests in packages/, 663 with the two apps
```

**None of the nine is on npm yet** — all are at `0.1.0`, and `npm view` returns
404 for every one. They are consumed here through the workspace.

> **One install note that bites silently.** `@libp2p/webrtc` needs
> `node-datachannel`, a native module whose install script pnpm 10 blocks
> unless it is named in `onlyBuiltDependencies` (it is, in
> `pnpm-workspace.yaml`). Drop that entry and pnpm prints
> `Ignored build scripts: node-datachannel` in a box, reports success, and
> `@statewalker/httpeers-member/node` then throws on import.

## Development

The whole repository — the libraries above *and* the two apps. (*Working on
them*, further up, is the narrower packages-only loop.)

```sh
pnpm install
pnpm run typecheck
pnpm run test        # binds real ports; starts real libp2p nodes
pnpm run build
```

Running it locally, where the bound address *is* reachable and so no announce
list is needed:

```sh
pnpm --filter @statewalker/httpeers-relay bootstrap     # writes .httpeers/relay.key
RELAY_REQUIRE_ANNOUNCE=false pnpm --filter @statewalker/httpeers-relay dev
```

## Deployment

See [`deploy/README.md`](deploy/README.md). In short: a wildcard A record and a
wildcard certificate, after which **publishing a new subdomain changes nothing
here** — no Caddyfile edit, no DNS record, no reload. Session origins
(`*.p.httpeers.net`) are the one exception: one more wildcard, set up once —
an `A *.p` record, a Caddy block with its own certificate, and the shell
published to the `p.httpeers.net` prefix.

## What the relay is, and is not

A stock libp2p **Circuit Relay v2** server over WebSockets, with **no
application code**: it serves no discovery, announces itself as a member of
nothing, and holds no directory. It is the one component in the system that is
genuinely infrastructure, and also the only one containing no project logic.

> **A note on the word.** `docs/httpeers/CONTEXT.md` marks this as a false
> friend. The domain's **Relay** is *a peer that forwards on a third party's
> behalf* — an application-level concern with a capability and a hop limit.
> This is the *libp2p circuit relay*, a transport component, and a different
> thing entirely. This repository contains only the second.

It is **open and capped**: anyone may reserve, and protection is quantitative
rather than authenticated. See `apps/relay/src/limits.ts`, which is the only
place those numbers are set and explains why the per-connection ones stay
small.

## The relay's per-connection limits — and why they are what they are

`apps/relay/src/limits.ts` applies **1 GiB and 6 hours** per relayed connection, plus
`maxReservations: 512` and a 2 h reservation TTL. Those are ceilings against a runaway peer, not
budgets a real session can reach. The numbers matter, and the reasoning behind them was arrived
at the expensive way.

### Why a limit exists at all

Circuit Relay **v2** is a *limited* relay by design: v1 relays were unlimited, were treated as
free public infrastructure, and people stopped running them. A cap buys three things:

- **Bounded egress.** A relay spends *its* bandwidth carrying traffic between two *third
  parties*. A cap makes the worst case computable instead of open-ended.
- **It is not an open proxy.** Without a cap, a public relay is free transport for arbitrary
  libp2p traffic, leaving the operator's address and allowance.
- **Pressure to upgrade.** If a circuit is unlimited, peers that could go direct have less reason
  to.

### Why the stock numbers are wrong here

The library defaults — **128 KiB and 2 minutes** — are sized for an identify exchange plus
hole-punch coordination, on the assumption that the circuit is only ever a signalling path. It is
not. **NAT traversal is negotiated per peer pair**, so within one mesh some pairs go direct and
others fall back — and for those, the circuit *is* the data path.

libp2p resets the stream when a reservation's budget is spent, so the application sees a
truncated response and **nothing anywhere says why**. This relay ran at 1 MiB, and a phone
loading an image gallery got roughly 1 MiB through before every remaining image broke; opening one
of them in a fresh tab worked, because a new connection gets a new budget. That reads as random
corruption rather than a quota.

*(The truncation that actually explained that gallery turned out to live elsewhere — a 5-second
close bound in `webrun-streams-libp2p` that aborted healthy transfers under concurrency. This cap
was not the culprit. It would have been the next one.)*

### The rule for choosing the numbers

**Any ceiling tight enough to matter against abuse is tight enough to truncate somebody's
gallery, and that failure is invisible at both ends.** So set the ceiling well above real usage:
a measured browser-to-browser gallery moved 63 MB across eighteen concurrent transfers, and 1 GiB
sits far above it. If bandwidth ever becomes the problem, **measure egress first** and lower the
ceiling to above observed usage rather than guessing below it.

`applyDefaultLimit` is all-or-nothing — it either attaches both figures or drops data *and*
duration together — which is why both are declared. Declaring one and omitting the other would
imply a ceiling that is not enforced.

## Bootstrapping from a URL

A peer that knows only `https://relay.httpeers.net` — with no peerId compiled
into it — can learn what to dial from

```
https://relay.httpeers.net/.well-known/httpeers-relay.json
```

```json
{
  "relayAddrs": [
    "/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3KooW…"
  ]
}
```

`relayAddrs` is the key `httpeers.json`'s invitation payload already uses; a
second shape for the same fact is how two sources of truth start.

**The relay does not serve this.** It writes the file at startup, to a path
given by `RELAY_BOOTSTRAP_PATH`, and Caddy serves it. Unset, nothing is written
and the relay behaves exactly as it did before this existed.

**It is generated from `node.getMultiaddrs()`, not from `RELAY_ANNOUNCE_ADDRS`.**
Generating it from configuration would look equivalent and would be a second
source of truth for the relay's address, free to drift from what the relay
actually advertises in the one direction nobody checks. See
`apps/relay/src/bootstrap-doc.ts`, and the integration test that compares the
written document against the node's own address list.

**A missing document means the relay is not running.** It is deleted before
every start attempt and written only once the relay is up, so a relay that
crash-loops yields 404 rather than a confident answer pointing at a relay that
is down.

### The client contract — pin on first use

This belongs in client code, not in this repository, but it is the entire
security argument and it has a sharp edge.

1. Fetch the document once, over HTTPS.
2. Persist the peerId alongside the relay URL.
3. Thereafter dial the **full** address including `/p2p/`, so Noise verifies
   the relay's identity on every connection.
4. If the published peerId ever differs from the pinned one, **fail loudly**.
   Never silently re-pin.

Trust before step 2 is DNS and the CA. Trust after step 2 is equal to a peerId
compiled in. The trade is not "as secure as pinning" — it is "as secure as
pinning, *after first contact*".

> **The inversion, which is the real risk.** If first contact is compromised,
> the client pins the **attacker's** peerId — permanently — and rule 4 then
> fires against the *legitimate* relay. That is not a degradation to no
> pinning; it is being locked to the attacker while loudly rejecting the real
> relay. "Never silently re-pin" is right; **"never re-pin" is unrecoverable.**

So a client MUST also carry a **deliberate reset path**: an explicit,
human-initiated action that forgets the pin so the next contact pins afresh.
Three properties make it safe rather than a hole in rule 4:

- **Only a human starts it.** Never the relay, never the document, never a
  header or a field in the JSON — nothing an attacker can also serve.
- **It shows both peerIds**, the pinned one and the published one, so the human
  can compare them against a source that is not the relay.
- **It is the same mechanism a legitimate key rotation needs.** The client
  cannot distinguish a rotated relay from a substituted one — which is exactly
  why the decision is a person's and not the client's.

### Why this is safe for a relay specifically

The relay is the one component not trusted with content: peer↔peer Noise runs
*inside* the circuit, and the target peer's id stays in the dialled address and
is still verified. A substituted relay can deny service and observe traffic
patterns; it cannot read what flows through.

**This reasoning does not transfer to the hub**, whose peerId is the mesh
identity. A hub bootstrap document would need its own argument, not this one.

## What the static-site host is

A site is a **first-level prefix in an S3 bucket, named after its domain**:
`sites/abc.httpeers.net/index.html`. Publishing is writing files — no DNS record, no
certificate, no ingress edit, no restart. The `Host` header resolves directly to a
prefix, so there is no index to build, nothing to invalidate, and collisions are
impossible because storage enforces key uniqueness.

Two behaviours worth knowing, both easy to get wrong:

- **`/foo` matching `/foo/index.html` returns 301 to `/foo/`.** Serving the body at the
  un-slashed URL breaks every relative link in the document — `img.png` resolves to
  `/img.png`, not `/foo/img.png` — and the symptom is missing images, not anything that
  looks like routing.
- **A missing file is a 404, never a 200 with an empty body.** `FilesApi.read()` returns
  an empty iterable for a path that does not exist rather than throwing, so existence is
  always established with `stats()` first.

Storage is chosen by environment (`s3` | `node` | `mem`) in `apps/sites/src/store.ts`,
which is the only module that knows which backend is in use.

## What a session origin is

`<name>.p.httpeers.net`, for any name: a separate **origin** — its own storage,
cookies and ServiceWorker — that serves the same static shell as every other
name, and shows whatever the page that opened it sends over a `MessagePort`.
It is how a page runs another peer's app without letting it touch its own
origin (see `docs/security-model.md` §6). The shell, its refusals and its
tests are in [`apps/session-shell`](apps/session-shell/README.md); the demo
that uses it is the app page's **Open in a new session**
([`apps/demos`](apps/demos/README.md)).

## Two things that are easy to get wrong

**The address it binds is not the address peers dial.** TLS is terminated by
the reverse proxy, so the relay speaks plain `ws` internally and must
*advertise* `/dns4/relay.httpeers.net/tcp/443/tls/ws`. libp2p advertises what it
listens on unless told otherwise, so without `RELAY_ANNOUNCE_ADDRS` the relay
starts, reports healthy, and is undialable — with a symptom pointing at the
relay's health rather than at its advertised address. It therefore refuses to
start without one. See `apps/relay/src/addresses.ts`.

**The signing key is the identity.** The relay's peerId is embedded in every
multiaddr any client will ever dial, so a regenerated key silently invalidates
every client's configuration at once. A missing key is a loud failure, never a
fresh identity. The key lives on a volume, never in the image, and never in
this repository. See `apps/relay/src/key.ts`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_PORT` | `9090` | The port the relay binds, inside the network. |
| `RELAY_KEY_PATH` | `./.httpeers/relay.key` | The identity. `/data/.httpeers/relay.key` in the image. |
| `RELAY_ANNOUNCE_ADDRS` | *(none — required)* | Comma-separated multiaddrs peers should dial. Must not contain `/p2p/`. |
| `RELAY_REQUIRE_ANNOUNCE` | `true` | Set `false` for a local run with no proxy in front. |
| `RELAY_KEY` | *(none)* | Base64 protobuf, to seed an empty volume. Ignored once a key exists. |
| `RELAY_BOOTSTRAP_PATH` | *(none; `/srv/bootstrap/.well-known/httpeers-relay.json` in the image)* | Where to write the bootstrap document. Unset, none is written. |
