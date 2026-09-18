# The LLM appliance

A self-contained mesh hub with an LLM service: `hub` (this repo's `apps/hub`,
built locally), `litellm` (LiteLLM, proxying to whatever model you configure),
`postgres` (LiteLLM's own state — keys, spend, models added through its UI),
and `traefik` (the only way in from the host, with basic auth).

Members reach the hub over the public httpeers mesh (WebRTC, or the
relay-circuit fallback when WebRTC is unavailable). On a Docker host behind a
home NAT the default bridge network makes the fallback the normal path (see
"Host networking" below); on the httpeers.net server, which has a public
address, members measured `direct` through the same bridge network. The
appliance itself needs outbound internet access (to `relay.httpeers.net`) but
publishes nothing except the admin door.

It runs in two places: on a workstation, built from source (the sections
below), and on the httpeers.net server, deployed by CI (see "On the
httpeers.net server").

## Prerequisites

- Docker with the Compose plugin (`docker compose version`).
- Outbound internet access from the Docker host (the hub fetches its relay
  document from `relay.httpeers.net` once at start and **exits 1 if it
  can't** — this is not optional).
- Nothing else already listening on `127.0.0.1:8080` on the host (Traefik's
  only published port).

## Setup

```sh
cd deploy/llm-appliance
cp .env.example .env
chmod 600 .env
```

### Secrets

Fill in `.env` (never commit it — it's gitignored, along with `data/`):

```sh
# LiteLLM's master key and its at-rest encryption key for stored credentials.
LITELLM_MASTER_KEY="sk-$(openssl rand -hex 32)"
LITELLM_SALT_KEY="sk-$(openssl rand -hex 32)"

# Postgres's password for the "litellm" user (compose.yml sets the user and
# database name; only the password is a secret).
POSTGRES_PASSWORD="$(openssl rand -hex 20)"

# LiteLLM's own dashboard login — separate from Traefik's basic auth below.
UI_USERNAME=admin
UI_PASSWORD="$(openssl rand -hex 12)"

# Traefik's basic auth: ADMIN_USER/ADMIN_PASSWORD are the plaintext pair a
# human (or scripts/health.sh) authenticates with; ADMIN_HTPASSWD is the
# htpasswd HASH of that same pair, which is what Traefik is actually
# configured with. Generate both together:
ADMIN_USER=admin
ADMIN_PASSWORD="$(openssl rand -hex 12)"
# If `htpasswd` isn't installed locally:
ADMIN_HTPASSWD="$(docker run --rm httpd:2.4-alpine htpasswd -nbB "$ADMIN_USER" "$ADMIN_PASSWORD")"

# The secret Traefik presents to the hub's local door (see "The admin door").
# Letters, digits, "_" and "-" only: Traefik's start script writes it into its
# config and refuses anything else.
HUB_DOOR_SECRET="$(openssl rand -hex 32)"
```

Every secret is required: `compose.yml` uses `${VAR:?}` for each, so
`docker compose up` refuses to start with one unset or empty.

Write each generated value into `.env` by hand (or script it — the snippet
above is shell, not a file to source).

**`ADMIN_HTPASSWD` needs single quotes in `.env`.** A bcrypt hash is full of
literal `$` characters (`admin:$2y$05$...`), and both `.env` files and
`env_file:` entries go through the same `${VAR}`-style interpolation
docker compose applies to the compose file itself — an *unquoted* `$2y$05$...`
gets read as a string of variable references (`$2`, `y`, `$05`, ...), all
undefined, and silently collapsed to nothing (VERIFIED: this reproduces with
the actual value, both via the default `.env` and via `env_file:`). Wrapping
the value in **single quotes** in `.env` (`ADMIN_HTPASSWD='admin:$2y$...'`)
stops that — `docker compose config`'s own display of the resulting service
still *shows* `$$`-doubled dollar signs, but that is only `config`'s own
round-trip-safe re-serialization; the value the container actually receives
was confirmed byte-for-byte correct (`docker compose run --rm traefik sh -c
'echo $ADMIN_HTPASSWD'` prints the untouched hash).

### The admin door

Traefik on `127.0.0.1:8080` (basic auth) is the only way in to the hub's
local door — the admin UI, `/hub/api/*`, and `/peers/<hubPeerId>/llm/*` with
the master key. Not publishing the hub's port is **not** enough by itself: a
Linux host routes to container bridge IPs, so every local process could
otherwise reach `http://<hub-container-ip>:8787` unauthenticated, and a web
page could through DNS rebinding. So the door checks every request:

1. **`x-hub-door-secret`** must equal `HUB_DOOR_SECRET`, or **401**. Traefik
   adds it after basic auth (the `door-secret` middleware, generated at
   Traefik's start from `.env`), replacing any value a client sent. The hub
   refuses to start without the secret.
2. **`Host`** must be in `HUB_DOOR_ALLOWED_HOSTS` (default
   `127.0.0.1:8080,localhost:8080` — Traefik passes the client's Host
   through), or **421**. If you publish Traefik elsewhere, change both.
3. A **non-GET/HEAD** request with an `Origin` must come from
   `http://<an allowed host>`, or **403**.

`scripts/health.sh` checks the last point from the outside: a direct request
to the hub container's own address must be refused.

### Bring it up

```sh
docker compose up -d --build
# or, for the local smoke test (a fake OpenAI upstream registered as model "fake"):
docker compose -f compose.yml -f compose.test.yml up -d --build
./scripts/health.sh
```

The first start takes a minute or two (the hub image builds; LiteLLM waits
for the hub's identity before it starts; Postgres and LiteLLM's own
`start_period`s add a little more). `docker compose ps` shows every
long-running service `healthy` once it's ready.

## Using it

- **Admin UI**: `http://127.0.0.1:8080/` (basic auth: `ADMIN_USER` /
  `ADMIN_PASSWORD`). Shows the mesh id and relay addresses, mints
  invitations (with a QR code), lists members — each with the link the hub
  currently has to it (`direct`, `relay`, or not connected) — with revoke, and
  links to the LiteLLM dashboard.
- **LiteLLM dashboard**: `http://127.0.0.1:8080/peers/<hubPeerId>/llm/ui/login/`
  (note the trailing slash — see "Rough edges" below), login with
  `UI_USERNAME` / `UI_PASSWORD`. `<hubPeerId>` is in `./data/hub/hub.env` and
  on the admin UI's own page.
- **Adding a real model**: in the LiteLLM dashboard, "Add Model" — pick a
  provider, paste its API key, save. It's stored in Postgres
  (`STORE_MODEL_IN_DB=True`), so it survives a restart. Members then see it
  in `GET /peers/<id>/llm/v1/models` (their key needs no reconfiguration).
- **Inviting a member**: mint an invitation in the admin UI (or
  `POST /hub/api/invitations {"roles":["member"]}` through the door), send
  them the link. They open it and join. A member **cannot mint a LiteLLM
  key** (the hub answers 403); give them one — see "LLM keys" below.

## LLM keys

**Only admins mint keys.** Three ways, all equivalent for LiteLLM:

- **The mesh page as an admin**: join `mesh.html` with an `admin` invitation
  and press "Request a key". It mints a key with alias
  `mesh-chat-<timestamp>` that **expires after 30 days** and has no budget.
- **The door**: `POST /peers/<hubPeerId>/llm/keys` through Traefik. The hub
  adds the master key itself and forwards only `key_alias`, `user_id`,
  `models`, `max_budget`, `budget_duration`, `duration`, `tpm_limit`,
  `rpm_limit` and `metadata`:

  ```sh
  curl -u "$ADMIN_USER:$ADMIN_PASSWORD" -H 'content-type: application/json' \
    -d '{"key_alias":"alice","duration":"30d","max_budget":5,"budget_duration":"30d","rpm_limit":30}' \
    "http://127.0.0.1:8080/peers/$HUB_PEER_ID/llm/keys"
  ```

- **LiteLLM's dashboard** ("Virtual Keys" → "Create New Key").

**Issue one key per member, with limits** (`max_budget`, `rpm_limit`,
`duration`), so one member's use is visible and bounded, and one key can be
revoked without touching the others. The member pastes it into the chat
page's Key step.

**Removing a member from the mesh does NOT revoke their LiteLLM key.**
`DELETE /hub/api/members/<peerId>` (or "Revoke" in the admin UI) takes away
their mesh access, so they can no longer reach this hub's LLM service — but
the key itself stays valid in LiteLLM, and anyone holding it who can reach
the service (another member it was shared with) can still use it. Revoke the
key in LiteLLM too: in the dashboard, or through the door with the master key:

```sh
curl -u "$ADMIN_USER:$ADMIN_PASSWORD" \
  -H "x-litellm-api-key: Bearer $LITELLM_MASTER_KEY" -H 'content-type: application/json' \
  -d '{"key_aliases":["alice"]}' \
  "http://127.0.0.1:8080/peers/$HUB_PEER_ID/llm/key/delete"
```

(The master key goes in `x-litellm-api-key`, not `Authorization` —
`litellm/config.yaml` points LiteLLM at that header.)

### Known risk: the dashboard on an app origin

LiteLLM's dashboard over the mesh (`https://<app origin>/peers/<id>/llm/ui/`)
runs **in that app's origin**: it shares the origin's storage (localStorage,
IndexedDB, cookies) and so the mesh identity that page holds, and the
dashboard's scripts could read or use them — as could any other page served
on that origin. Admins should open the dashboard from a **dedicated origin**
(one that hosts nothing else and holds no identity worth protecting) or from
the local door, `http://127.0.0.1:8080/peers/<hubPeerId>/llm/ui/login/`.

## Host networking (EXPERIMENTAL, Linux only)

**EXPERIMENTAL: never brought up, only validated with `docker compose
config`.** Test it yourself before relying on it.


By default the hub is bridge-networked, so members without a working WebRTC
path always fall back to the relay circuit — this works everywhere but adds
a hop. `compose.host.yml` puts the hub (and Traefik, so it can still reach
the hub's local door) on `network_mode: host` for direct WebRTC:

```sh
docker compose -f compose.yml -f compose.host.yml up -d --build
```

**Warning: do not run this on Compose < 2.24 (no `!reset` support).**
VERIFIED against this task's actual installed Compose (v2.3.3): `docker
compose -f compose.yml -f compose.host.yml config` renders without error,
but the base file's `networks:`/`ports:` entries are still silently merged
in alongside `network_mode: host` (`!reset` is a no-op on that version) —
`docker compose up` refuses that combination outright. If your Compose is
older and doesn't support `!reset`, hand-edit `compose.yml` to drop the
`networks:`/`ports:` lines from the `hub` and `traefik` services before
layering `compose.host.yml` on top, or upgrade Compose.

This needs **Compose >= 2.24** (the `!reset` merge tag). It was **not
exercised beyond `docker compose config`** — the default bridge/relay-fallback
`compose.yml` is the one verified; this variant was never brought up (it
would also collide with the already-running bridge stack).

In this variant the door listens on the host's `127.0.0.1:8787`, gated exactly
as above (door secret, Host allowlist, Origin). **LiteLLM is not published on
the host**: the host-networked hub reaches it at a fixed bridge address
(`LITELLM_BRIDGE_IP`, default `172.31.87.40`, on `APPLIANCE_SUBNET`, default
`172.31.87.0/24` — pick one that does not collide with your networks). As in
the default variant, local processes can route to that bridge address; LiteLLM's
own authentication (master key, virtual keys, dashboard login) is what guards
it.

## On the httpeers.net server

The same appliance runs on the httpeers.net host (`163.172.46.87`, see the server runbook in
the notes), beside, but separate from, the relay/Caddy/sites stack in `/opt/httpeers`: its own
directory `/opt/httpeers-llm`, its own compose project `httpeers-llm`, its own bridge network.
Caddy does not route to it and nothing about it is public: members reach the hub over the mesh
(through `relay.httpeers.net`), invitations open `https://llm-chat.httpeers.net/mesh.html`, and
the LLM backend is OpenRouter.

| Service | Reachable from | Notes |
| --- | --- | --- |
| `hub` | the mesh; its door only from Traefik | `ghcr.io/statewalker/httpeers-hub:sha-<commit>` |
| `traefik` | **`127.0.0.1:8080` on the server only** | basic auth, then the door secret. Admin UI via SSH tunnel |
| `litellm` | the appliance network only | models from `litellm/config.server.yaml` (OpenRouter) |
| `postgres` | the appliance network only | LiteLLM's keys and spend |

### The admin UI

```sh
ssh -N -L 8080:127.0.0.1:8080 kotelnikov@163.172.46.87
# then open http://127.0.0.1:8080/ -- ADMIN_USER / ADMIN_PASSWORD from the server's .env:
ssh kotelnikov@163.172.46.87 'grep -E "^ADMIN_(USER|PASSWORD)=" /opt/httpeers-llm/.env'
```

**Use local port 8080** (or `localhost:8080`): the door answers only the Host values in
`HUB_DOOR_ALLOWED_HOSTS`, and a tunnel on another local port gets a 421. Minting an invitation
without the UI, on the server:

```sh
cd /opt/httpeers-llm && set -a && . ./.env && set +a
curl -s -u "$ADMIN_USER:$ADMIN_PASSWORD" -H 'content-type: application/json' \
  -d '{"roles":["member"]}' http://127.0.0.1:8080/hub/api/invitations    # .link is the join URL
```

### How a change reaches it

`.github/workflows/llm-appliance.yml`, on a push to `main` touching the hub, the packages or
this directory:

1. **publish** builds `apps/hub/Dockerfile` and pushes `ghcr.io/statewalker/httpeers-hub` as
   `sha-<commit>` and `latest`. The image carries this directory's deployment files under
   `/appliance` (compose files, LiteLLM and Traefik config, `scripts/health.sh`, `server/`), so
   one sha pins the code and the configuration together. A pull request builds the image
   without pushing it.
2. **deploy** (only when the repository variable `LLM_DEPLOY_ENABLED` is `true`) connects over
   SSH with a **forced-command key** and sends `deploy <sha>`. Whatever the client sends, that key
   runs only `/opt/httpeers-llm/bin/deploy.sh` (`server/deploy.sh`), which accepts a 40-hex sha and
   nothing else. It pulls that sha's image, copies `/appliance` into `releases/<sha>/`,
   and runs `docker compose up -d --wait`. It then checks that the hub's peerId is unchanged,
   `scripts/health.sh` passes, and LiteLLM lists models through the door. When any check fails
   it brings the previous release back up and fails the job.

**Why this mechanism** rather than the relay's plain SSH key or a pull-based updater:

- The relay's `DEPLOY_SSH_KEY` can run any command as a `docker`-group user, which is root in
  effect. This key is `restrict`ed (no pty, no forwarding) and can only choose which CI-built
  image runs. GHCR, which only this repository's workflows can write to, is the trust anchor.
- A pull-based updater (Watchtower, a timer polling GHCR) updates images but not compose files.
  Its failures show in no pull request and in no run list, and it needs a registry poll loop
  on the host. The push model gives a red job when a deploy does not verify.
- A failed deploy prints container **status only**, never logs. The Actions log of a public
  repository is public, and the hub's or LiteLLM's logs can name invitations, keys or
  request bodies.

Measured on the server, 2026-09-18:

- LiteLLM's first start against an empty database took about 2.5 min (migrations), hence
  `compose.server.yml`'s `start_period: 600s`.
- Traefik answered 404 for a few seconds after `--wait` returned, hence the door wait in
  `deploy.sh`.
- With `APPLIANCE_DATA_DIR` set, a deploy recreates `hub`, `litellm` and `traefik` but not
  `postgres`. Expect about a minute without the LLM service per deploy.

### Layout on the server

```
/opt/httpeers-llm/
  .env                 mode 600: every secret, plus COMPOSE_PROJECT_NAME, COMPOSE_FILE
                       (compose.yml:compose.server.yml:compose.release.yml),
                       APPLIANCE_DATA_DIR=/opt/httpeers-llm/data, OPENROUTER_API_KEY
  data/hub/            the hub's identity and state   } back these up; see "Backup and data"
  data/postgres/       LiteLLM's database              }
  releases/<sha>/      one release's /appliance files, .env and data symlinked in,
                       and compose.release.yml pinning the hub image
  current -> releases/<sha>
  bin/deploy.sh        installed by hand from server/deploy.sh
  deploy.log           one line per deploy
```

Operating it by hand, on the server: `cd /opt/httpeers-llm/current && docker compose ps` (or
`logs hub`). After editing `.env`, run `bin/deploy.sh redeploy`. `bin/deploy.sh status` shows the
running release. **Roll back** with `bin/deploy.sh deploy <older sha>`: every `sha-` image of
the last three releases stays on the host, and any older one is pulled again from GHCR.

### One-time setup (done 2026-09-18; repeat only to rebuild the host)

1. `install -d -o kotelnikov -m 750 /opt/httpeers-llm` (as root), then in it `data/`,
   `releases/`, `bin/` (mode 700).
2. `.env`: generate every secret on the server, as in "Secrets" above (`openssl rand`, the
   htpasswd hash single-quoted), and add `COMPOSE_PROJECT_NAME=httpeers-llm`,
   `COMPOSE_FILE=compose.yml:compose.server.yml:compose.release.yml`,
   `APPLIANCE_DATA_DIR=/opt/httpeers-llm/data`, `HUB_JOIN_PAGE_URL` and
   `OPENROUTER_API_KEY`. Send the OpenRouter key over stdin, never on a command line. Mode 600.
3. `scp server/deploy.sh` to `bin/deploy.sh.new`, then `mv` it over `bin/deploy.sh`. The
   rename matters: `sh` reads a script while it runs, and overwriting a running deploy in place
   corrupts it. **Re-install it by hand after every change to `server/deploy.sh`**, because the
   copy inside the image is only for reference.
4. The key: `ssh-keygen -t ed25519 -N "" -C llm-deploy@httpeers -f k`. Append
   `restrict,command="/opt/httpeers-llm/bin/deploy.sh" <k.pub>` to `~kotelnikov/.ssh/authorized_keys`.
   Then `gh secret set LLM_DEPLOY_SSH_KEY < k` and `shred -u k k.pub`.
5. The repository variables: `gh variable set DEPLOY_KNOWN_HOSTS` with the output of
   `ssh-keyscan -t ed25519 163.172.46.87` (compare it with a known fingerprint first), and
   `gh variable set LLM_DEPLOY_ENABLED --body true`. `DEPLOY_HOST` and `DEPLOY_USER` are the
   relay's existing secrets.

## Backup and data

Everything durable lives under `./data/` (gitignored), or under `APPLIANCE_DATA_DIR` when that is
set (`/opt/httpeers-llm/data` on the server):

- `./data/hub/hub.key` — the hub's Ed25519 identity. **Never regenerate this
  without meaning to**: deleting it changes `hub.env`'s `HUB_PEER_ID`, which
  changes every invitation link, every member's mesh address for this hub,
  and LiteLLM's `SERVER_ROOT_PATH` (LiteLLM reads `hub.env` once at its own
  start — restarting the hub with the *same* key changes nothing for
  LiteLLM, but restarting LiteLLM after the hub's key changed picks up the
  new path; **you must also restart `litellm`** after ever deleting
  `hub.key`).
- `./data/hub/state/`, `./data/hub/rules.dl`, `./data/hub/revocations.json`
  — members, invitations, the rule set, and revocations.
- `./data/postgres/` — LiteLLM's Postgres data (keys, spend, added models).

Back all of `./data/` up together; `hub.key` and Postgres's data are
independent, but a mismatched restore (an old hub key with a Postgres
snapshot that has newer key/model data tied to a different `HUB_PEER_ID`
under `STORE_MODEL_IN_DB`) is at worst a cosmetic mismatch, not data loss —
LiteLLM's own tables aren't keyed by `HUB_PEER_ID`.

## Troubleshooting

- **A chat reply just stops after ~30s with no error.** LiteLLM (like most
  proxies) times out a request; a **non-streaming** call slower than that
  gets a 502 at the mesh edge. Streaming (`stream: true`) has no such limit
  — prefer it.
- **A member is stuck on the relay (`hubLink: relay`) even though you
  expected direct WebRTC.** On a host behind NAT that is the default and
  correct behavior of the plain `compose.yml` (bridge network) — see "Host
  networking" above. It is also the correct fallback for any member whose own
  network blocks WebRTC, regardless of the hub's networking. (On the
  httpeers.net server, with a public address, members measured `direct`.)
- **`docker compose up` hangs with `litellm` unhealthy.** Check
  `docker compose logs litellm` for `litellm-entrypoint: timed out ... waiting
  for /data/hub/hub.env` — this means the hub itself failed to start (check
  `docker compose logs hub`; the most common cause is no outbound internet
  access to `relay.httpeers.net`).
- **The LiteLLM dashboard redirects off-mesh (to `127.0.0.1:4100` or similar)
  the first time you open it unauthenticated.** A known LiteLLM limitation
  (it has no reverse-proxy Host/Proto awareness for one specific redirect —
  see `docs/research/2026-09-15-llm-appliance-spikes/litellm-ui-through-mesh.md`).
  Always enter through `/peers/<id>/llm/ui/login/` (**with** the trailing
  slash), not `/peers/<id>/llm/ui/`, to avoid it.
- **Rough edges inherited from LiteLLM itself** (not this appliance): a
  couple of the dashboard's very first data-fetch calls after login can 401
  silently (self-heals — most are refetched); a full-page reload while
  logged in can show a burst of 404s on data widgets that self-heals within
  a few seconds (a ServiceWorker dispatch race on the mesh edge, not a
  LiteLLM or hub bug). Both are documented in the spike report above.

## Files

| Path | What |
| --- | --- |
| `../../apps/hub/Dockerfile` | The hub image (multi-stage; build context is the repo root) |
| `compose.yml` | The appliance: hub, litellm, postgres, traefik |
| `compose.host.yml` | EXPERIMENTAL: direct WebRTC via host networking (Linux) |
| `compose.test.yml` | Local smoke test: a fake OpenAI upstream + model registration |
| `compose.server.yml` | The httpeers.net server: the hub pulled from GHCR, OpenRouter models, LiteLLM's long first start |
| `litellm/config.server.yaml` | The server's model list (OpenRouter; the key comes from the environment) |
| `server/deploy.sh` | The server's forced-command deploy script (installed by hand as `/opt/httpeers-llm/bin/deploy.sh`) |
| `e2e/` | The end-to-end run on the real domains, against this machine's appliance or the server's |
| `../../.github/workflows/llm-appliance.yml` | CI: publish the hub image, deploy it to the server |
| `.env.example` | Secrets template — copy to `.env` |
| `litellm/config.yaml` | LiteLLM's config (the key-header fix; no secrets) |
| `litellm-entrypoint.sh` | Waits for the hub's identity, sets `SERVER_ROOT_PATH`/`PROXY_BASE_URL`, execs LiteLLM |
| `traefik/dynamic.yml`, `traefik/dynamic.host.yml` | Traefik's file-provider dynamic config (router, basic auth then the door secret, service); `door-secret.yml` is generated beside it at start |
| `scripts/health.sh` | Smoke-checks the running stack through Traefik |
| `test/fake-llm.mjs`, `test/register-model.mjs` | compose.test.yml's fake upstream and model-registration one-shot |
