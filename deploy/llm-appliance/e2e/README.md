# End-to-end test on the real domains

`e2e.mjs` drives the whole LLM appliance the way a person would: through the published chat page
on `https://llm-chat.httpeers.net/mesh.html`, the public relay `relay.httpeers.net`, and the hub
running on this machine. The results of the last recorded run are in `RESULTS.md`.

## Prerequisites

- **The appliance is running** from `deploy/llm-appliance` (see `../README.md`), with the test
  upstream registered as model `fake`:

  ```sh
  cd deploy/llm-appliance
  docker compose -f compose.yml -f compose.test.yml up -d
  ./scripts/health.sh
  ```

  The script reads `../.env` for `ADMIN_USER`/`ADMIN_PASSWORD` (the Traefik door's basic auth)
  and `UI_USERNAME`/`UI_PASSWORD` (LiteLLM's dashboard login). `HUB_JOIN_PAGE_URL` should be the
  published page; when it is, the hub's own invitation `link` is used as the join URL.
- **The llm-chat build is published** to the page URL (`apps/llm-chat`, `pnpm run build`, then
  the contents of `dist/` — `index.html`, `mesh.html`, `sw.js`, `assets/` — at the domain root).
  The ServiceWorker must be served as `/sw.js` with a JavaScript content type.
- **Dependencies are installed** for `apps/llm-chat`: Playwright is resolved from there, because
  `deploy/` is not a workspace package. The host needs its Chromium (`npx playwright install
  chromium` if missing).
- **Docker can run** `mcr.microsoft.com/playwright:v1.63.0-noble` (pulled on first use), and the
  image's Playwright version matches the host's (`1.63.0`); `chromium.connect` refuses a mismatch.
- **The host port for run-server is free** (`127.0.0.1:3100` by default; `E2E_PW_PORT` changes
  it). Port 3000 was taken on the machine this was first run on.
- The machine reaches the internet: the browsers load the page and dial the public relay.

## Running

From the httpeers repository root:

```sh
E2E_ARTIFACTS=/tmp/llm-e2e node deploy/llm-appliance/e2e/e2e.mjs
```

Every step prints `PASS`, `FAIL` or `SKIP` with its duration, then the link modes and the aliases
of the keys minted. The exit code is non-zero if any step did not pass. Screenshots of failing
steps, the dashboard, the member page after revocation, and `results.json` (all the recorded
facts, no secrets) go to `E2E_ARTIFACTS` (a new temporary directory by default).

The script prints no credentials, invitations or keys.

Other settings are listed at the top of `e2e.mjs`: `HUB_DOOR_URL`, `MESH_PAGE_URL`,
`HUB_CONTAINER`, `E2E_NETWORK`, `E2E_PW_CONTAINER`, `E2E_PW_IMAGE`, `E2E_KEEP_ISOLATED=1` (leave the
isolated container and network up) and `LLM_MODEL`.

## Against the httpeers.net server

The same script drives the appliance CI deployed on the server (see `../README.md`, "On the
httpeers.net server"). The browsers run on this machine, so they are on a different network
from the hub by construction.

```sh
ssh -N -L 8080:127.0.0.1:8080 kotelnikov@163.172.46.87 &      # the door, as on the workstation
HUB_CONTAINER=remote LLM_MODEL=gpt-4o-mini \
APPLIANCE_ENV=<(ssh kotelnikov@163.172.46.87 \
  'grep -E "^(ADMIN_USER|ADMIN_PASSWORD|UI_USERNAME|UI_PASSWORD|LITELLM_MASTER_KEY)=" /opt/httpeers-llm/.env') \
node deploy/llm-appliance/e2e/e2e.mjs
```

- `HUB_CONTAINER=remote` replaces the isolation control's probe of a local hub container, which
  does not exist here, with the page check alone.
- With a real model (anything but `fake`), a reply is complete when the chat's own action bar
  (Copy / Regenerate, hidden while a run is in progress) appears under it, with non-empty text.
- The credentials come from a process substitution and are never written to disk here.
- A real model costs a few tokens per run: one "hello" per browser, plus one short "ping" per
  revocation poll.

Nothing of the local appliance is needed: stop it first if it holds `127.0.0.1:8080`.

## What it does

1. **Hub is up.** `GET /hub/api/mesh` through the door gives `hubPeerId`.
2. **Admin joins over the relay.** The script creates the Docker network `llm-e2e-isolated`,
   starts the Playwright image on it running `run-server`, published on `127.0.0.1:3100`, and
   connects with `chromium.connect`. A control check runs `curl` inside that container: the hub
   container's IP must be unreachable and the page must load. Browser A joins from an `admin`
   invitation and must show `Connected (relay)` or `Connected (direct)` — the mode is recorded.
   It requests a key, the model picker lists `fake`, and the reply to "hello" is sampled while it
   grows and must complete.
3. **Dashboard.** In A's context, `/peers/<hub>/llm/ui/` over the mesh (the entry the hub
   advertises — never `/ui/login/`, see the appliance README's "The dashboard's entry point");
   log in; the
   dashboard shows `Virtual Keys` and `Create New Key` and `key/list` answers 200. Every non-2xx
   response under the llm mount is listed; a 403 or a 5xx fails the step.
4. **Member is refused admin paths.** Browser B, a fresh context in the isolated browser, joins
   from a `member` invitation. `POST …/llm/keys` and `GET …/llm/ui/` must answer 403. B
   pastes A's key and chats.
5. **Revocation.** A streamed chat call from B's page must succeed, then
   `DELETE /hub/api/members/<B>`, then B's calls are repeated every second until one is refused
   with **403 and a JSON `error`/`reason` naming the revocation** (`revoked`, case-insensitive).
   That sample is the recorded latency. Any other outcome — a timeout, a network error, a 5xx, a
   200 — keeps polling; with no such 403 within 90 s the step fails and prints the last outcome.
6. **Host browser.** Browser C, launched on the host, joins from a `member` invitation; its link
   mode is recorded. This step runs even if steps 2–5 failed.

Steps 2–5 are chained: a failure skips the ones after it.

Every `docker` call has a timeout (120 s for `docker run`, which may pull; 30 s otherwise), so a
hung daemon fails the run instead of hanging it.

Afterwards the isolated container and network are removed, and the keys the run minted are
deleted (reported separately, see "Side effects").

## Side effects

- Each run adds members to the hub (A, B — revoked — and C); they are not cleaned up.
- Each run mints one LiteLLM key, alias `mesh-chat-<ISO timestamp>` (30-day expiry). After the
  steps, the script deletes the keys it minted through the door (`POST …/llm/key/delete` with
  `{"key_aliases": [...]}` and the master key in `x-litellm-api-key`, read from `.env` as
  `LITELLM_MASTER_KEY`). The cleanup prints its own `PASS`/`FAIL` line and never changes the exit
  code; a failed cleanup leaves the key for an admin to delete (see `../README.md`, "LLM keys").
- The member's refused `POST …/llm/keys` never reaches LiteLLM.
