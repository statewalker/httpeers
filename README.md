# httpeers

The httpeers mesh's deployable services. Today: the **circuit relay**, and the
ingress that fronts it.

Design and decisions live in the umbrella repository:
`docs/superpowers/specs/2026-09-06-httpeers-relay-production-design.md`, and the
mesh's own vocabulary in `docs/httpeers/CONTEXT.md`.

## Layout

```
apps/relay/        the circuit relay, and its image
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
