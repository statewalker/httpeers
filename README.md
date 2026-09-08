# httpeers

The httpeers mesh's deployable services. Today: the **circuit relay**, the
**static-site host**, and the ingress that fronts both.

Live at `relay.httpeers.net`, `s3.httpeers.net` and `*.httpeers.net`.

Design and decisions live in the umbrella repository:
`docs/superpowers/specs/2026-09-06-httpeers-relay-production-design.md`, and the
mesh's own vocabulary in `docs/httpeers/CONTEXT.md`.

## Layout

```
apps/relay/        the circuit relay, and its image
apps/sites/        the static-site host -- one site per storage prefix
deploy/            the compose stack, the Caddyfile, the ingress image
.github/workflows/ ci, and one image-publishing workflow per deployable
```

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

## The relay applies no per-connection limits — and why

`apps/relay/src/limits.ts` sets `applyDefaultLimit: false`. A relayed connection
has **no byte ceiling and no time ceiling**. This is a deliberate reversal, recorded here
because the reasoning it replaced was plausible, and because it is worth restoring one day.

### Why the limit exists in libp2p at all

Circuit Relay **v2** exists because v1 relays were unlimited, were treated as free public
infrastructure, and people stopped running them. v2 is explicitly a *limited* relay: it makes a
peer dialable just long enough to upgrade to a direct connection, then leaves the data path. The
stock defaults — **128 KiB and 2 minutes** — are sized for exactly that: an identify exchange and
hole-punch coordination, nothing more.

Applying a limit buys three things:

- **Bounded egress.** A relay spends *its* bandwidth carrying traffic between two *third
  parties*. A cap makes the worst case computable instead of open-ended.
- **It is not a proxy.** Without a cap, a public relay is a free transport for arbitrary libp2p
  traffic, leaving the relay operator's address and allowance.
- **Pressure to upgrade.** If a circuit is unlimited, peers that could go direct have no reason
  to. The limit is part of what makes a direct connection the normal path.

### Why it is off here

Those benefits assume the circuit is only ever a signalling path. It is not. **NAT traversal is
negotiated per peer pair**, so within one mesh some pairs go direct and others fall back to the
circuit — and for those, the circuit *is* the data path.

With a 1 MiB cap that failed like this: a phone loading an image gallery got roughly 1 MiB
through, and every image after that was broken. libp2p resets the stream when a reservation's
budget is spent, so the application sees a truncated response and **nothing anywhere says why**.
Opening one of the broken images in a fresh tab worked — a new connection, a new budget — which
makes it look like random corruption rather than a quota. The duration limit had the same shape:
a relayed connection open past the cap is cut off just as silently.

The trade taken: **an invisible truncation that looks like data corruption is worse than
bandwidth you can measure.**

### What still bounds this relay

`maxReservations: 512` and the 2 h reservation TTL. Those bound **how many** peers hold a slot,
not **how much** they move. There is currently no byte or time ceiling on a relayed connection.

### Restoring it

`applyDefaultLimit` is all-or-nothing — it leaves the reservation's `limit` undefined, dropping
data *and* duration together — which is why no `defaultDataLimit` or `defaultDurationLimit` is
declared: a configured but unenforced number reads as a protection that exists.

To restore, set `applyDefaultLimit: true` and give both **generous** values — gigabytes and
hours, not the 1 MiB and 5 minutes that caused this. The rule to keep in mind: any ceiling tight
enough to matter against abuse is tight enough to truncate somebody's gallery, and that failure
is invisible at both ends. If bandwidth becomes the problem, measure egress first and set the
ceiling above real usage rather than below it.

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

## Development

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
here** — no Caddyfile edit, no DNS record, no reload.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_PORT` | `9090` | The port the relay binds, inside the network. |
| `RELAY_KEY_PATH` | `./.httpeers/relay.key` | The identity. `/data/.httpeers/relay.key` in the image. |
| `RELAY_ANNOUNCE_ADDRS` | *(none — required)* | Comma-separated multiaddrs peers should dial. Must not contain `/p2p/`. |
| `RELAY_REQUIRE_ANNOUNCE` | `true` | Set `false` for a local run with no proxy in front. |
| `RELAY_KEY` | *(none)* | Base64 protobuf, to seed an empty volume. Ignored once a key exists. |
| `RELAY_BOOTSTRAP_PATH` | *(none; `/srv/bootstrap/.well-known/httpeers-relay.json` in the image)* | Where to write the bootstrap document. Unset, none is written. |
