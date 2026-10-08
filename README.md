# httpeers

## What it is

A peer-to-peer mesh where **everything is a `fetch()`**. Peers — Node
processes and browser pages — serve HTTP handlers to each other over libp2p,
and a page calls another peer with its own `fetch()` through a ServiceWorker
edge. This repository holds both halves:

- **`packages/`** — the libraries a page or a process builds a mesh from,
  published to npm under `@statewalker/*`, plus two private conformance suites.
- **`apps/` and `deploy/`** — the services the mesh needs to exist and the
  pages that run on them: the circuit relay (`relay.httpeers.net`), the
  static-site host (`*.httpeers.net`), the session shell (`*.p.httpeers.net`),
  the S3 storage behind them (`s3.httpeers.net`), the ingress, the Node hub
  daemon with its LLM appliance, the LLM chat and the demo pages.

**Before building on it, read [`docs/security-model.md`](docs/security-model.md).**
The mesh mounts every peer's HTTP surface into your own origin and calls it
with your identity automatically, so *data* crosses that boundary safely but
*code* does not. That document defines the valid uses and the ones to avoid.

## Layout

```
packages/              the libraries (below)
apps/relay/            the circuit relay, and its image
apps/sites/            the static-site host: one site per storage prefix, and its image
apps/session-shell/    the empty session every <name>.p.httpeers.net serves
apps/hub/              the Node hub daemon (identity, rules, service modules, admin UI), and its image
apps/appliance-prepare/ hardware probe and config generator for the local-model LLM appliance
apps/llm-chat/         the chat page: standalone (index.html) or over the mesh (mesh.html)
apps/demos/            the demo sites: hub, app, images, proxy
deploy/                the production compose stack, the Caddyfile, the ingress image
deploy/llm-appliance/  hub + LiteLLM + Postgres + Traefik, locally or on the server
tools/publish/         shell toolkit: publish sites by editing a folder
docs/                  the security model
.github/workflows/     CI, and one image workflow per deployable
```

### The libraries

One contract runs through all of them: `FetchHandler = (Request) => Promise<Response>`.
A mount table routes it, a peer serves it over libp2p, an edge lets a page
reach it through its own `fetch()`. Only `httpeers-libp2p` knows what libp2p
is.

| Package | npm | What it is |
|---|---|---|
| [`httpeers-core`](packages/httpeers-core) | [`@statewalker/httpeers-core`](https://www.npmjs.com/package/@statewalker/httpeers-core) | the handler contract, the mount router, the identity and token headers; no dependencies |
| [`httpeers-access`](packages/httpeers-access) | [`@statewalker/httpeers-access`](https://www.npmjs.com/package/@statewalker/httpeers-access) | who is calling, and may they: Biscuit tokens, Datalog policy, revocation, one middleware; no libp2p |
| [`httpeers-person`](packages/httpeers-person) | [`@statewalker/httpeers-person`](https://www.npmjs.com/package/@statewalker/httpeers-person) | person keys, the statements they sign, and the link code; no dependencies |
| [`httpeers-bridge`](packages/httpeers-bridge) | [`@statewalker/httpeers-bridge`](https://www.npmjs.com/package/@statewalker/httpeers-bridge) | fetch over a duplex, both directions, with no transport in it; `./ports` runs a mesh over `MessageChannel` |
| [`httpeers-libp2p`](packages/httpeers-libp2p) | [`@statewalker/httpeers-libp2p`](https://www.npmjs.com/package/@statewalker/httpeers-libp2p) | the transport: nodes, identity, relay reservations, `servePeer` |
| [`httpeers-hub`](packages/httpeers-hub) | [`@statewalker/httpeers-hub`](https://www.npmjs.com/package/@statewalker/httpeers-hub) | invitations, membership tokens and the registries; no transport, so a hub can run in a tab |
| [`httpeers-member`](packages/httpeers-member) | [`@statewalker/httpeers-member`](https://www.npmjs.com/package/@statewalker/httpeers-member) | everything a participant does: `startMember`, the session, the edge, the gateway |
| [`httpeers-ghost`](packages/httpeers-ghost) | [`@statewalker/httpeers-ghost`](https://www.npmjs.com/package/@statewalker/httpeers-ghost) | a remote peer's app rendered as a page that can reach only that peer |
| [`httpeers-qr`](packages/httpeers-qr) | [`@statewalker/httpeers-qr`](https://www.npmjs.com/package/@statewalker/httpeers-qr) | invitations as QR: pure encode/decode, plus a browser camera scanner |
| [`httpeers-join`](packages/httpeers-join) | [`@statewalker/httpeers-join`](https://www.npmjs.com/package/@statewalker/httpeers-join) | the join-the-mesh widget every page shares, in plain DOM |
| [`webrun-biscuit`](packages/webrun-biscuit) | [`@statewalker/webrun-biscuit`](https://www.npmjs.com/package/@statewalker/webrun-biscuit) | Biscuit tokens in pure TypeScript: codec, signatures, Datalog, authorizer |
| [`httpeers-conformance`](packages/httpeers-conformance) | private | every entry point resolved and imported as a dependent sees it, and one real mesh |
| [`httpeers-browser-conformance`](packages/httpeers-browser-conformance) | private | what only a real browser can answer: the ServiceWorker edge, reset, reloads |

The apps (`apps/*`) are all private: they ship as container images or static
sites, never to npm.

Other `@statewalker/*` packages used here come from npm: `webrun-streams`,
`webrun-streams-libp2p`, `webrun-http-streams`, `webrun-http-browser`,
`webrun-http-proxy`, `webrun-rpc` and `webrun-files*`.

## How to run it

Requirements: **Node 24** and **pnpm 10** through corepack (the version is
pinned in `package.json`'s `packageManager`).

1. `corepack enable`
2. `pnpm install`
3. `pnpm build` — every package and app (`pnpm -r run build`; `pnpm turbo build`
   builds in dependency order and caches).
4. `pnpm test` — every package's tests. They bind real ports and start real
   libp2p nodes. A package's `test` script builds and typechecks it first.
5. `pnpm typecheck`, `pnpm lint:check`, `pnpm format:check`.

One package: `pnpm --filter @statewalker/httpeers-member test`.

A relay on this machine, where the bound address is reachable and so no
announce address is needed:

```sh
pnpm --filter @statewalker/httpeers-relay bootstrap     # writes apps/relay/.httpeers/relay.key
RELAY_REQUIRE_ANNOUNCE=false pnpm --filter @statewalker/httpeers-relay dev
```

Each app's README says how to run it: [relay](apps/relay/README.md),
[sites](apps/sites/README.md), [session shell](apps/session-shell/README.md),
[hub](apps/hub/README.md), [llm-chat](apps/llm-chat/README.md),
[demos](apps/demos/README.md).

### Deployment: merging to `main` publishes images

[`deploy/README.md`](deploy/README.md) is the runbook for the production host:
four containers (Caddy, relay, sites, RustFS) behind a wildcard DNS record and
wildcard certificates, so publishing a new subdomain changes nothing there.
The LLM appliance is a separate stack, described in
[`deploy/llm-appliance/README.md`](deploy/llm-appliance/README.md).

A push to `main` that touches a deployable builds and pushes its image
(`.github/workflows/relay.yml`, `sites.yml`, `ingress.yml`, `llm-appliance.yml`).
The relay and sites workflows then deploy over SSH when the repository variable
`DEPLOY_ENABLED` is `true`, and the LLM appliance workflow when
`LLM_DEPLOY_ENABLED` is `true`; the ingress is deployed by hand. The LLM
appliance workflow watches all of `packages/**`, so any change there — a README
included — rebuilds and redeploys the hub. On a pull request, CI runs and the
LLM appliance image is built without being pushed.

## Why it is the way it is

### Proven identity is a header, and every ingress strips it

`x-httpeers-peer` carries the peer the *transport* proved. A header survives a
re-created `Request` — which is what handlers do — and lets the security
property be tested in plain HTTP. Because a header is whatever the caller
typed, `registerPeer`, `registerAnonymous` and `stripPeerBinding` all strip
before they write, and every entry point calls exactly one of them.
`httpeers-conformance` checks it over a real libp2p connection: a peer claiming
to be somebody else is overwritten by the handshake.

### The membership token has its own header; `Authorization` is the application's

`x-httpeers-token` carries the bare token (`MESH_TOKEN_HEADER` in
`httpeers-core`, the only place the name is spelled). The edge, `peerRequest`
and the ghost write it; `withAccess` reads it and nothing else.
`Authorization` passes through the mesh untouched, for whatever application the
request is addressed to — for example LiteLLM's own API key. A proxy
re-issuing a request outside the mesh strips `MESH_CREDENTIAL_HEADERS` (the
token and the proven peer), never `Authorization`. `httpeers-conformance` scans
every library's source to keep it that way.

### A package's root is isomorphic; platform code sits behind an entry point

A package's root runs in Node, in a worker and in a page alike; anything that
cannot goes behind `./node` or `./browser`. Each package's boundary test
enforces it — in `httpeers-member` and `httpeers-qr` by walking the import
closure of `index.ts`, so the rule is "nothing a root import reaches", not
"these file names are exempt".

### A compile check and a runtime check are different claims

A published entry point can type-check and still fail to import, and two
packages that pass their own tests can still fail together.
`httpeers-conformance` compiles every entry point the way a dependent does,
imports every isomorphic one, and stands up a live relay, hub and two members
with nothing stubbed.

## What will surprise you

- **`node-datachannel` must be allowed to build.** `@libp2p/webrtc` needs this
  native module, and pnpm 10 blocks install scripts unless a package is named
  in `onlyBuiltDependencies` (it is, in `pnpm-workspace.yaml`). Remove that
  entry and pnpm prints `Ignored build scripts: node-datachannel`, reports
  success, and `@statewalker/httpeers-member/node` then throws on import.
- **Apps bundle workspace packages from `dist/`.** The packages' `exports` have
  a `source` condition, but the Vite builds do not enable it. After changing a
  package, rebuild it before building or testing an app that uses it.
- **Merging to `main` changes production.** See
  [Deployment](#deployment-merging-to-main-publishes-images).
- **The word "relay" means two things.** In the mesh's vocabulary a Relay is a
  peer that forwards on a third party's behalf; `apps/relay` is the libp2p
  circuit relay, a transport component.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm build` | `pnpm -r run build` |
| `pnpm test` | `pnpm -r run test` |
| `pnpm typecheck` | `pnpm -r run typecheck` |
| `pnpm lint` / `pnpm lint:check` | Biome check, with or without `--write` |
| `pnpm format` / `pnpm format:check` | Biome format, with or without `--write` |
| `pnpm turbo build` / `pnpm turbo test` | the same through turbo: dependency order and caching |

### Continuous integration and releases

CI runs on every pull request and every push to `main`: a frozen
`pnpm install`, a check of dependency-reference conventions (`workspace:^`
inside the repository, `catalog:` for external versions), `lint:check`,
`format:check`, `build`, `typecheck`, `test`, and checks that every published
entry point exists in `dist/`, imports, and packs. The public packages are
published to npm under `@statewalker/*`.

### License

MIT — see [`LICENSE`](LICENSE).
