# @statewalker/httpeers-hub-daemon

## What it is

The Node hub daemon: a persistent httpeers hub with its own identity, rules and
state on disk, built-in service modules (today `llm`, a passthrough to
LiteLLM), an admin REST API, and a **local door** — an HTTP server for the
local operator that serves the admin UI. It is the hub of the LLM appliance
(`deploy/llm-appliance`) and ships as the image `ghcr.io/statewalker/httpeers-hub`,
which also carries the appliance's compose files. Private; never published.

## Layout

| Path | What it is |
|---|---|
| `src/main.ts` | the entry point: reads the environment, starts the daemon, stops it on a signal |
| `src/config.ts` | every setting, from the environment (`loadConfig(env)`) |
| `src/daemon.ts` | `startDaemon`: identity → rules → relay document → node → reservation → hub → revocations → `servePeer` → local door → `READY <peerId>` |
| `src/identity.ts` | `hub.key` (the Ed25519 identity) and `hub.env` (`HUB_PEER_ID=<peerId>`, rewritten on every start) |
| `src/rules.ts` | `rules.dl`, written from defaults once, the operator's from then on |
| `src/state.ts` | revocations that survive a restart (`revocations.json`) |
| `src/admin-api.ts`, `src/admin-openapi.ts` | the admin REST API under `/hub/api/*` and its OpenAPI document |
| `src/local-door.ts` | the local door |
| `src/modules.ts`, `src/service-module.ts`, `src/services/llm/` | service modules, chosen by `HUB_SERVICES` |
| `ui/` | the admin UI (Vite), built into `dist-ui/` |
| `Dockerfile` | the image (build context: the repository root) |

Data, under `<HUB_DATA_DIR>/hub/`: `hub.key`, `hub.env`, `rules.dl`, `state/`,
`revocations.json`.

## How to run it

The supported way is the LLM appliance, which runs this daemon next to LiteLLM,
Postgres and a reverse proxy: see
[`deploy/llm-appliance/README.md`](../../deploy/llm-appliance/README.md).

To run the daemon alone (it reserves on the relay named by `HUB_RELAY_DOC`, by
default the public one):

1. `pnpm --filter @statewalker/httpeers-hub-daemon build` — `dist/` and `dist-ui/`.
2. Start it:

   ```sh
   cd apps/hub
   HUB_DATA_DIR=./.data HUB_DOOR_SECRET=change-me pnpm start
   ```

3. Wait for `READY <hubPeerId>`. The local door listens on `0.0.0.0:8787` and
   answers only requests that carry `x-hub-door-secret: change-me` and a `Host`
   in `HUB_DOOR_ALLOWED_HOSTS` (default `127.0.0.1:8080`, `localhost:8080`) —
   in the appliance, the reverse proxy adds both.

## Why it is the way it is

### The start order fails early and serves late

Rules load before anything touches the network, so a broken `rules.dl` fails
the start at once. The hub reserves on the relay before it serves, so by the
time a member dials, the hub is reachable the way members reach it. `READY` is
printed once, last, when both the mesh and the local door are serving.

### The hub serves on limited connections

A hub in Docker on a bridge network cannot be reached over WebRTC, so its
members fall back to a kept relay circuit through the public relay.
`serveOnLimitedConnection` lets the hub answer them. It does not open the hub's
own relay to application traffic; that limit is on the relay server.

### The local door trusts only its reverse proxy

The door never goes through `withAccess`: a local request has no
transport-proven peer and would be refused before any policy ran. Its gate is
the reverse proxy in front of it (basic auth on `127.0.0.1:8080`), and three
checks on every route that make that proxy the only client it answers:

1. `x-hub-door-secret` must equal `HUB_DOOR_SECRET` (constant-time), or **401**.
   The proxy sets it; it is stripped before a module sees the request.
2. `Host` must be in `HUB_DOOR_ALLOWED_HOSTS`, or **421**. A DNS-rebound page
   carries its own domain as `Host`.
3. A request that is not GET/HEAD and carries `Origin` must come from
   `http://<allowed host>`, or **403** (`local door: cross-origin request refused`).

Not publishing the port is not enough: a Linux host routes to a container's
bridge IP, so any local process could reach the door directly. The door
refuses to start without a secret.

Routes: `/hub/api/*` (the admin API, no access layer), `/peers/<hubPeerId>/<module>/…`
(a service module, called directly with `caller: "local"`), and the admin UI
for everything else. `/ui` at the origin root is redirected (307) to the
LiteLLM dashboard under `/peers/<hubPeerId>/llm/ui/`, because the dashboard's
client router can escape to the root.

### The admin API has two ways in and one handler

Over the mesh it is mounted at `/hub` behind `withAccess` and capability
`std:mesh.admin` (which the default rules give to `role("admin")`); through the
local door it is called directly. Routes: `/hub/api/mesh`, `/hub/api/relay`,
`/hub/api/health`, `/hub/api/roles`, `/hub/api/invitations` (GET, POST),
`/hub/api/members`, `/hub/api/members/{peerId}` (DELETE),
`/hub/api/openapi.json`. `POST /hub/api/invitations` answers
`{ id, expiresAt, blob, link }`, where `link` is `HUB_JOIN_PAGE_URL` plus
`?join=<blob>`; the default TTL is 24 hours.

### Rules: the operator's file, plus code-owned policies appended at load

`rules.dl` is JSON — `{ "version": 1, "rules": [...], "policies": [...] }`, the
input `ruleSet()` takes — written from defaults on first start and the
operator's after that. A service module's rules and the admin API's policy are
appended at load and never written to the file: they change with the code, and
writing them would freeze one version in the operator's file. The admin policy
is appended only if the rules still derive `std:mesh.admin`; otherwise the hub
starts and warns, and the admin API stays reachable through the local door.

### Revocations survive a restart

`createHub` keeps revocations in memory, so a restarted hub would honour a
revoked member's still-valid token again. `src/state.ts` records every change
in `revocations.json` (write-then-rename) and re-applies unexpired entries on
start. On SIGTERM the daemon flushes revocations before stopping, and exits
non-zero if the stop takes more than 8 s (Docker's grace period is 10 s).

## What will surprise you

- `hub: HUB_DOOR_SECRET is not set; the local door will not start without it (the reverse proxy sends it as x-hub-door-secret)`
  — the daemon refuses to start without the secret.
- `hub: HUB_SERVICES includes "llm" but HUB_LLM_UPSTREAM and LITELLM_MASTER_KEY are not set`
  — enabling `llm` without its settings is a startup error, not a
  half-working service.
- `hub: unknown service "<id>" in HUB_SERVICES (known: …)`.
- **`hub.key` is the mesh.** The hub's peerId is the mesh's name and is in every
  token; a new key is a new, empty mesh, and every member must join again.
  Back up `<HUB_DATA_DIR>/hub/` as a whole.
- **`HUB_MAX_RESERVATIONS` must exceed the members connected at once.** A member
  that cannot reserve on the hub falls back to relay mode and cannot be reached
  by other members.

## Reference

### Commands

| Command (`pnpm --filter @statewalker/httpeers-hub-daemon …`) | What it does |
|---|---|
| `build` | `tsc` into `dist/`, then the UI into `dist-ui/` |
| `start` | `node dist/main.js` |
| `test` | Vitest (config, rules, state, local door, admin API, the `llm` module, a daemon against an in-process relay) |
| `test:ui` | build, then `tests/ui.e2e.mjs`: the admin UI in a real browser against a real daemon, all on loopback |
| `typecheck`, `lint:check` | `tsc --noEmit` (daemon and UI), Biome |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HUB_DATA_DIR` | `/data` | data root; the hub owns `<dir>/hub` |
| `HUB_RELAY_DOC` | `https://relay.httpeers.net/.well-known/httpeers-relay.json` | where to read `{ relayAddrs }` |
| `HUB_SERVICES` | none | comma-separated service modules (`llm`) |
| `HUB_LLM_UPSTREAM`, `LITELLM_MASTER_KEY` | — | required when `HUB_SERVICES` includes `llm` |
| `HUB_JOIN_PAGE_URL` | `https://llm-chat.httpeers.net/mesh.html` | the page an invitation link opens |
| `HUB_LOCAL_DOOR_PORT` | `8787` | the local door's port |
| `HUB_LOCAL_DOOR_HOST` | `0.0.0.0` | bind address; use `127.0.0.1` for a host-networked hub |
| `HUB_DOOR_SECRET` | none — required | the value the proxy sends as `x-hub-door-secret` |
| `HUB_DOOR_ALLOWED_HOSTS` | `127.0.0.1:8080,localhost:8080` | `Host` values the door answers |
| `HUB_MAX_RESERVATIONS` | `4096` | relay reservations the hub grants its members |

An empty value counts as unset.
