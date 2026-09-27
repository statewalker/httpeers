# Manual remote check — NOT YET PERFORMED

**Status: NOT YET PERFORMED.** No automated gate in this repository exercises real NAT traversal
(`e2e.mjs`'s browsers always run on this machine — see `e2e/README.md` and `REMOTE-CHECK.md` for
why that proves nothing about a real second network). The procedure is written and ready
(`REMOTE-CHECK.md`); it needs a phone on mobile data with Wi-Fi off, or a VM on a genuinely
different network, which this task did not have access to. **Do not read the fields below as a
result — every one of them is a placeholder, waiting to be filled in by whoever actually runs
`REMOTE-CHECK.md`.**

| Field | Value |
| --- | --- |
| Date | *(not yet run)* |
| Client network | *(not yet run — e.g. "iPhone, Wi-Fi off, [carrier] mobile data" or "VM on [provider/region]")* |
| Transport (page indicator) | *(not yet run)* |
| Transport (`GET /hub/api/members`'s `link` field, read after the chat exchange) | *(not yet run)* |
| Time to join | *(not yet run)* |
| First-token latency | *(not yet run)* |
| Failure, verbatim (if any) | *(not yet run)* |

When this is actually performed, replace this section with the filled-in result, keep the
**manual** heading and the date, and leave the earlier automated runs below untouched — they test a
different thing (same-host, everything else) and remain valid on their own terms.

---

# End-to-end results — 2026-09-21, local-model appliance (`--local`)

**Outcome: all six steps PASS, key cleanup PASS** (run of 2026-09-21 about 23:09 UTC, exit 0;
`node e2e/e2e.mjs --local` from `deploy/llm-appliance`).

- **Target.** The local-model backend (Task 10/11) on this workstation: llama.cpp server
  (`ghcr.io/ggml-org/llama.cpp:server-vulkan`, backend `vulkan`), LiteLLM, Postgres and Traefik,
  all `healthy`. Door `http://127.0.0.1:8081` (`.env`'s `APPLIANCE_DOOR_PORT`).
- **Models.** The `small` tier, from `models/manifest.lock.json`: `qwen2.5-1.5b-instruct`,
  `qwen2.5-3b-instruct`. `LLM_MODEL` defaulted to `qwen2.5-1.5b-instruct` (the tier's first id).
- **Browsers.** A and B in an isolated Docker network (`llm-e2e-isolated`), C on the host, exactly
  as in server mode. The published page was `https://llm-chat.httpeers.net/mesh.html` — unchanged;
  only the door and the join mechanics point at the local appliance.
- **Machine.** `kotelnikov-laptop`, Linux 6.8.0-139-generic x86_64, 8 cores, 31 GiB RAM.

| Step | Result |
| --- | --- |
| 1. Hub is up | PASS (14 ms). hubPeerId `12D3KooWNpep9WXELWBybdRaX3xAnPNrhDGNfFB8qWnzJFAA6PSF` |
| 2. Admin A joins (blob pasted into the join form), mints a key, chats | PASS (18.3 s). **relay**, joined in 7.2 s. The picker listed exactly `["qwen2.5-1.5b-instruct","qwen2.5-3b-instruct"]` — asserted equal to the lock file. First token in **355 ms**; the streamed reply completed in 961 ms after 12 partial states: "Hello! How can I help you today?" (non-empty, asserted) |
| 3. Dashboard over the mesh | PASS (13.7 s). 125 responses under the mount, 4 non-2xx (the known `ui.txt`/`__next._tree.txt` 404s and a 307), none of them 403 or 5xx |
| 4. Member B refused admin paths, chats with A's key | PASS (8.8 s). **relay**, joined in 7.2 s. `POST …/llm/keys` and `GET …/llm/ui/login/` answered 403. First token in **202 ms**; reply completed in 993 ms |
| 5. Revocation | PASS (3.3 s). A 403 `{"error":"membership revoked"}` came **59 ms** after the `DELETE` answered (first attempt); B's page showed the revocation |
| 6. Host browser C | PASS (1.3 s). **direct**, joined in 1.2 s |

Link modes: `{"A":"relay","B":"relay","C":"direct"}`. The hub's own view (`GET
/hub/api/members`) listed all three as `direct` (the same transient effect documented in the
2026-09-15 run below: a failed WebRTC upgrade's connection stays open for ~12 s after the fallback
to relay). No assertion was made about which mode any of them showed — a same-host run proves
nothing about real NAT traversal (Task 15 carries the manual remote check that does).

**Revocation double-check, by hand, outside the script.** After the recorded run, a second,
independent script (admin + one member, both on the host, no Docker isolation) minted a key,
confirmed a baseline streamed completion (200, first chunk), called `DELETE
/hub/api/members/<peerId>`, and immediately re-issued the *exact same* completion call once, with
its own timer — not the script's retry-every-second loop. Result: **403 `{"error":"membership
revoked"}` in 5 ms**, well under the one-second bar. The minted key was deleted afterwards through
the door.

**A prior run** (before the `firstTokenMs` instrumentation and the dashboard flake below) also
passed all six: A relay 7.3 s / 542 ms reply / 10 partials, B relay 7.7 s / 2.8 s reply, revocation
403 in 140 ms.

**One flaky run, diagnosed and not repeated.** An earlier attempt failed at step 3 (Dashboard)
with LiteLLM's own Next.js UI showing "Application error: a client-side exception has occurred"
after login, no `pageerror` recorded and `key/list` never reached the server. Reproduced in
isolation with console/response logging on the dashboard tab: on the very next attempt the same
flow rendered `Virtual Keys` and 8 existing keys cleanly — same code, same appliance, no change in
between. This matches an already-documented class of first-load flakiness in this dashboard (see
"Known risk" and the first-fetch 401 races noted in the 2026-09-18 run below), not something
`--local`'s four differences touch: step 3's code path (login, "Virtual Keys" wait, non-2xx
listing) is identical in both modes. Steps 4–5 were `SKIP`ped that run because they chain after
step 3; no assertion was weakened to route around it — the run was simply repeated, twice, both
clean.

---

# End-to-end results — 2026-09-18, the httpeers.net server

**Outcome: all six steps PASS, key cleanup PASS** (run of 2026-09-18 about 12:18 UTC, exit 0).

- **Target.** The appliance CI deployed on the server (release `077069c`: hub, LiteLLM with
  OpenRouter, Postgres and Traefik in `/opt/httpeers-llm`).
- **Browsers.** They ran on the workstation, behind a home NAT, which is a different network
  from the server. Browsers A and B were in an isolated Docker network, C on the host. The door
  was reached through `ssh -L 8080:127.0.0.1:8080`, and the model was `gpt-4o-mini`.
- **Page.** `https://llm-chat.httpeers.net/mesh.html` with the shared join widget
  (`mesh-DJWhf1m6.js`).

| Step | Result |
| --- | --- |
| 1. Hub is up | PASS. hubPeerId `12D3KooWNAjNwj1vY8hHPGaFXHLDaCTiCytGhxB8gyq1j4osbYXj` |
| 2. Admin A joins, mints a key, chats | PASS. **direct**, joined in 1.1 s. The picker listed `claude-haiku-4.5`, `gemini-2.5-flash`, `gpt-4o-mini`, `llama-3.3-70b`. The streamed reply completed in 2.1 s after 8 partial states |
| 3. Dashboard over the mesh | PASS. 127 responses under the mount, 9 non-2xx, none of them 403 or 5xx (the known LiteLLM first-fetch 401s) |
| 4. Member B refused admin paths, chats with A's key | PASS. **relay** (joined in 7.1 s). `POST …/llm/keys` and `GET …/llm/ui/login/` answered 403, and the reply came in 2.0 s |
| 5. Revocation | PASS. A 403 `membership revoked` came 65 ms after the DELETE (first attempt), and the page showed the revocation |
| 6. Host browser C | PASS. **direct**, joined in 1.1 s |

The hub's own view (`GET /hub/api/members`) listed A, B and C as `direct`. B's page said relay
at join time, and the hub's link to it was direct by the time it was read.

**The join widget on the live page, separately.** A fresh Chromium with no saved identity opened
`mesh.html`, pasted a member invitation link into the widget, and pressed Join. It was
`Connected (direct)` in 1.25 s, and the LLM key step followed. The test members were revoked
afterwards.

**Not measured:** a phone on mobile data, or any network other than this workstation's. The
earlier phone run (2026-09-15) was against a workstation hub, not this server.

---

# End-to-end results — 2026-09-15

**Outcome: all six steps PASS, key cleanup PASS** (recorded run, 2026-09-15 19:10:45–19:11:31 UTC,
exit 0).

This is the run after the final review's fix wave, against a redeployed appliance: the hub image
built from the fix commits (the local door now requires Traefik's `x-hub-door-secret`, an allowed
Host and a same-origin `Origin`), Traefik with the generated `door-secret` middleware, and the
republished mesh page. It replaces the previous recorded run (18:34 UTC, image from Task 7, page
from `ea2eeae`); earlier runs are summarised at the end.

## Environment

| | |
|---|---|
| Branch / commit under test | httpeers `llm-appliance`, **`ee6acf6`** (the fix wave `0fefb26`…`ee6acf6`; `ee6acf6` only adds the hub-link record to `e2e.mjs`) |
| Hub | `12D3KooWG3kQk68qzWzY8z6ECB59RF1HutZJmtuVa2m3AmQHaioQ` (unchanged across the redeploy; `./data` kept), container `llm-appliance-hub-1`, image `llm-appliance_hub` **`sha256:23ff309878702e4fdd4c062fe88e448151400f2566dddb8a52ef3b7bdcf5b711`**, built at `2d4c6aa` (`apps/hub` identical at `ee6acf6`) |
| Page | `https://llm-chat.httpeers.net/mesh.html`, built from `apps/llm-chat` at `2d4c6aa` and republished before the run (`mesh.html` `c8acbbae…`, `assets/mesh-Dn-WKHw0.js` `621db48d…`; bucket = dist = live for all 8 files) |
| LiteLLM | `ghcr.io/berriai/litellm:main-v1.83.14-stable` (`sha256:1baaaf7357c8…`), model `fake` → `test/fake-llm.mjs` |
| Other images | `traefik:v3.6.4` (`sha256:ce5c90e0c7d1…`), `postgres:16` (`sha256:80f4c7a5e916…`, not recreated), `node:24-bookworm-slim` |
| Relay | `/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa` |
| Door | Traefik `http://127.0.0.1:8080`, basic auth, then `door-secret` |
| Isolated browser | `mcr.microsoft.com/playwright:v1.63.0-noble` `run-server` on `llm-e2e-isolated`, published `127.0.0.1:3100`; Chromium 153.0.8010.12 |
| Host browser | Playwright 1.63.0 `chromium.launch()`, Chromium 153.0.8010.12 |
| Docker | engine 28.1.1, Compose 2.3.3 |

`scripts/health.sh` before the run: **ALL PASS**, including the new check that a request straight to
the hub container (`172.27.0.2:8787`) without the door secret is refused (401).

## Steps

| # | Step | Result | Time |
|---|---|---|---|
| 1 | Hub is up (`GET /hub/api/mesh` → `hubPeerId`, `services: ["llm"]`) | PASS | 31 ms |
| 2 | Admin A (isolated) joins, requests a key, picker lists `fake`, streamed reply completes | PASS | 18 255 ms |
| 3 | Dashboard over the mesh: log in, renders, non-2xx listed | PASS | 14 197 ms |
| 4 | Member B (isolated): `POST …/llm/keys` 403, `GET …/llm/ui/login/` 403, chats with A's key | PASS | 8 422 ms |
| 5 | Revocation of B: 403 naming the revocation | PASS | 3 297 ms |
| 6 | Host browser C joins as a member | PASS | 1 393 ms |
| — | Cleanup: delete the keys this run minted | PASS | 41 ms |

Step 2's time includes starting the run-server container. Step 5's includes a 3 s pause to
screenshot B's page after the failing call.

### Step 2 — isolation control and admin over the relay

- Control, from inside the isolated container: `curl http://172.27.0.2:8787/hub/api/mesh` **failed**,
  curl exit 28 (timeout). `https://llm-chat.httpeers.net/mesh.html` from the same container: 200.
- A joined in **7 141 ms: `Connected (relay)`**; `?join=` gone from the address bar.
- Request a key: `POST …/llm/keys` → 200, alias `mesh-chat-2026-09-15T19:11:03.170Z` (the page now
  asks for `duration: "30d"`).
- The model picker listed `["fake"]`; reply to "hello": `"reply to: hello (model fake-model)"` in
  363 ms, 6 partial states observed.

### Step 3 — dashboard

Logged in, landed on `/peers/<hub>/llm/ui/`, `Virtual Keys` and `Create New Key` rendered,
`GET /key/list` → 200. 127 responses under `/peers/<hub>/llm`; 9 non-2xx, none 403 and none 5xx —
the same set as every earlier run:

| Status | Request (under `/peers/<hub>/llm`) | A later identical call got 2xx |
|---|---|---|
| 404 | `GET /ui.txt` | — |
| 307 | `GET /ui` (to `/ui/`) | — |
| 401 | `GET /user/available_users` | no |
| 401 | `GET /health/license` | no |
| 401 | `GET /organization/list` | yes |
| 401 | `GET /team/list` | yes |
| 401 | `GET /get/ui_settings` | yes |
| 307 | `HEAD` on the mount itself, no trailing slash | yes |
| 404 | `GET /__next._tree.txt` | — |

The 401s are the first burst right after login (LiteLLM's first-fetch race recorded by the Task 7
spike); the 404s are Next.js probes for files LiteLLM's build does not ship.

### Step 4 — member refused admin paths

B joined in **7 193 ms: `Connected (relay)`** as peer
`12D3KooWRLbE8eQ4LvmffviqKW1tGS6rCtQiL3xK2Z55PzSE7nrb`. `POST …/llm/keys` → **403**,
`GET …/llm/ui/login/` → **403**. With A's key: `"reply to: hello from B (model fake-model)"` in
449 ms.

### Step 5 — revocation

Baseline streamed call from B's page: 200, `[DONE]`. After `DELETE /hub/api/members/<B>`, B's
**first** call — **63 ms** after the DELETE answered — was **403 `{"error":"membership revoked"}`**
(attempt 1). B's page still showed `Connected (relay)` afterwards (the indicator does not reflect a
revocation).

### Step 6 — host browser

C joined in **1 213 ms: `Connected (direct)`**.

### Cleanup — keys

`POST /peers/<hub>/llm/key/delete {"key_aliases": ["mesh-chat-2026-09-15T19:11:03.170Z"]}` through
the door with the master key: `deleted_keys` 1 of 1.

## Link modes observed

| Browser | Where | Page shows | Join time | Hub's `link` right after the join |
|---|---|---|---|---|
| A (admin) | isolated Docker network | **relay** | 7 141 ms | `direct` (transient, see below) |
| B (member) | isolated Docker network | **relay** | 7 193 ms | `direct` (transient, see below) |
| C (member) | host | **direct** | 1 213 ms | `direct` |

The hub's `link` (`GET /hub/api/members`) is computed from its open connections to each member. The
test samples it right after the join, and for A and B it said `direct` although both are on the
relay. A separate probe, polling every 2 s after an isolated browser joined, showed why: the hub
keeps the **failed WebRTC upgrade's connection open, unlimited, for about 12 s** after the member
has fallen back to the relay (`direct` at 9–19 s after `goto`, then `relay` from 21 s on, steady
for the rest of the 50 s probe). A Node member that never attempts WebRTC was reported `relay` at
once. So the column is right in steady state and can show `direct` for ~12 s after a failed
upgrade. The public relay's circuits are limited on both ends (measured: 1 GiB / 6 h), so a
circuit is never mistaken for direct.

## Keys in LiteLLM

Before this run, the keys left by Task 7's smoke test, Task 8's smoke runs and the earlier E2E runs
were deleted through the door (`POST …/llm/key/delete` with `key_aliases`, master key in
`x-litellm-api-key`): `mesh-chat-2026-09-15T17:56:14.878Z`, `…17:56:57.426Z`, `…17:57:24.108Z`,
`…17:58:08.973Z`, `…17:58:38.005Z`, `…18:08:27.781Z`, `…18:22:37.317Z`, `…18:23:54.928Z`,
`…18:34:29.571Z`, and `task7-smoke-test` — 10 of 10 deleted. **`phone-test` was kept** (the only
key left; it still answers `GET …/llm/v1/models` with 200). The keys minted by this run and by the
run just before it (19:09, same result, all PASS) were deleted by the script's own cleanup.

## Page errors

None.

## Earlier runs the same day

- **19:09:29–19:10:19 UTC**, same deployment, `2d4c6aa` (before the hub-link record was
  added): all six PASS, cleanup PASS; A relay 7 279 ms, B relay 7 162 ms, C direct 1 176 ms;
  revocation 403 after 77 ms.
- **18:34 UTC**, the previous recorded run (hub image `sha256:319979ae9d74…` from Task 7, page from
  `ea2eeae`, door without the secret): all six PASS; A relay 7 171 ms, B relay 7 043 ms, C direct
  1 080 ms; revocation 403 after 57 ms.
- **18:23 UTC**: all six PASS, but its step 5 accepted any failure as revocation (since fixed).
- **18:22 UTC**: step 5 failed at its baseline call (the probe did not stream; a test defect).
