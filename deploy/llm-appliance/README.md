# The LLM appliance

A self-contained mesh hub with an LLM service: `hub` (this repo's `apps/hub`,
built locally), `litellm` (LiteLLM, proxying to whatever model you configure),
`postgres` (LiteLLM's own state — keys, spend, models added through its UI),
and `traefik` (the only way in from the host, with basic auth).

Members reach the hub over the public httpeers mesh (WebRTC, or the
relay-circuit fallback when WebRTC is unavailable — this appliance's default
bridge network makes the fallback the normal path; see "Host networking"
below for direct WebRTC). The appliance itself needs outbound internet
access (to `relay.httpeers.net`) but publishes nothing except the admin door.

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
```

### Secrets

Fill in `.env` (never commit it — it's gitignored, along with `data/`):

```sh
# LiteLLM's master key and its at-rest encryption key for stored credentials.
LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
LITELLM_SALT_KEY="sk-$(openssl rand -hex 24)"

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
```

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
  `ADMIN_PASSWORD`). Shows the mesh id and relay/direct link mode, mints
  invitations (with a QR code), lists members with revoke, and links to the
  LiteLLM dashboard.
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
  them the link. They open it, join, and (if allowed by their role) can
  request their own LiteLLM key from the chat page.

## Host networking (optional, Linux only)

By default the hub is bridge-networked, so members without a working WebRTC
path always fall back to the relay circuit — this works everywhere but adds
a hop. `compose.host.yml` puts the hub (and Traefik, so it can still reach
the hub's local door) on `network_mode: host` for direct WebRTC:

```sh
docker compose -f compose.yml -f compose.host.yml up -d --build
```

This needs **Compose >= 2.24** (the `!reset` merge tag). It was **not
exercised in this task's verification** — the verification below runs the
default bridge/relay-fallback `compose.yml` only. If your Compose is older
and doesn't support `!reset`, you'll need to hand-edit `compose.yml` to drop
the `networks:` line from the `hub` and `traefik` services before layering
`compose.host.yml` on top (Docker refuses a service with both `network_mode`
and `networks:` set).

## Backup and data

Everything durable lives under `./data/` (gitignored):

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
  expected direct WebRTC.** That's the default and correct behavior on the
  plain `compose.yml` (bridge network) — see "Host networking" above. It is
  also the correct fallback for any member whose own network blocks WebRTC,
  regardless of the hub's networking.
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
| `compose.host.yml` | Optional: direct WebRTC via host networking (Linux) |
| `compose.test.yml` | Local smoke test: a fake OpenAI upstream + model registration |
| `.env.example` | Secrets template — copy to `.env` |
| `litellm/config.yaml` | LiteLLM's config (the key-header fix; no secrets) |
| `litellm-entrypoint.sh` | Waits for the hub's identity, sets `SERVER_ROOT_PATH`/`PROXY_BASE_URL`, execs LiteLLM |
| `traefik/dynamic.yml`, `traefik/dynamic.host.yml` | Traefik's file-provider dynamic config (router, basic auth, service) |
| `scripts/health.sh` | Smoke-checks the running stack through Traefik |
| `test/fake-llm.mjs`, `test/register-model.mjs` | compose.test.yml's fake upstream and model-registration one-shot |
