# End-to-end results — 2026-09-15

**Outcome: all six steps PASS** (recorded run, 2026-09-15 18:34:13–18:34:56 UTC, exit 0).

This file records the run after review fix round 1 (step 5 now accepts only a 403 that names the
revocation; docker calls have timeouts). It replaces the previous recorded run (18:23 UTC) in the
sections below; both earlier runs are summarised under "Earlier runs the same day".

## Environment

| | |
|---|---|
| Page | `https://llm-chat.httpeers.net/mesh.html` (built from `apps/llm-chat` at `ea2eeae`, published the same day) |
| Hub | `12D3KooWG3kQk68qzWzY8z6ECB59RF1HutZJmtuVa2m3AmQHaioQ`, container `llm-appliance-hub-1`, image `llm-appliance_hub` `sha256:319979ae9d74…` (built at Task 7's `efdfe91`; `9c715e2` only trimmed the image's files and was not redeployed) |
| Branch / commit under test | httpeers `llm-appliance`, `ea2eeae` |
| LiteLLM | `ghcr.io/berriai/litellm:main-v1.83.14-stable` (`sha256:1baaaf7357c8…`), model `fake` → `test/fake-llm.mjs` |
| Other images | `traefik:v3.6.4`, `postgres:16`, `node:24-bookworm-slim` (fake upstream) |
| Relay | `/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa` (the hub's relay document default) |
| Door | Traefik `http://127.0.0.1:8080`, basic auth |
| Isolated browser | `mcr.microsoft.com/playwright:v1.63.0-noble` `run-server` on the user-defined network `llm-e2e-isolated`, published `127.0.0.1:3100`; Chromium 153.0.8010.12 |
| Host browser | Playwright 1.63.0 `chromium.launch()`, Chromium 153.0.8010.12 |
| Docker | engine 28.1.1, Compose 2.3.3 |

The published page's hosting, as measured: `/` and `/index.html` both serve `index.html`;
`/mesh.html` and the extensionless `/mesh` both serve `mesh.html`; `/sw.js` is
`text/javascript; charset=utf-8`; `.css` is `text/css`; every file is `cache-control: public,
no-cache`; unknown paths are 404. The hub's `HUB_JOIN_PAGE_URL` is the published `mesh.html`, so
its invitation `link` was used as the join URL.

## Steps

| # | Step | Result | Time |
|---|---|---|---|
| 1 | Hub is up (`GET /hub/api/mesh` → `hubPeerId`, `services: ["llm"]`) | PASS | 24 ms |
| 2 | Admin A (isolated) joins, requests a key, picker lists `fake`, streamed reply completes | PASS | 17 064 ms |
| 3 | Dashboard over the mesh: log in, renders, non-2xx listed | PASS | 12 845 ms |
| 4 | Member B (isolated): `POST …/llm/keys` 403, `GET …/llm/ui/login/` 403, chats with A's key | PASS | 8 062 ms |
| 5 | Revocation of B: 403 naming the revocation | PASS | 3 291 ms |
| 6 | Host browser C joins as a member | PASS | 1 218 ms |

Step 2's time includes starting the run-server container. Step 5's includes a 3 s pause to
screenshot B's page after the failing call.

### Step 2 — isolation control and admin over the relay

- Control, from inside the isolated container: `curl http://172.27.0.2:8787/hub/api/mesh` (the hub
  container's only IP) **failed**, curl exit 28 (timeout after 5 s). `curl
  https://llm-chat.httpeers.net/mesh.html` from the same container: HTTP 200.
- A joined in **7 171 ms: `Connected (relay)`**. The ~7 s is the single WebRTC attempt timing out,
  then the kept relay circuit.
- `?join=` was gone from the address bar after the join.
- Request a key: `POST …/llm/keys` → 200, alias `mesh-chat-2026-09-15T18:34:29.571Z`.
- The model picker listed `["fake"]`.
- Reply to "hello": `"reply to: hello (model fake-model)"` in 340 ms from Send, with 6 partial
  states of the assistant bubble observed before the complete text. (The chat UI reveals text
  gradually on its own, so partial states show the reply growing on screen, not by themselves that
  the transport streamed. Streaming over the mesh itself was established by Task 7's curl and the
  conformance test.)

### Step 3 — dashboard

Logged in with `UI_USERNAME`/`UI_PASSWORD`, landed on `/peers/<hub>/llm/ui/`, `Virtual Keys` and
`Create New Key` rendered, `GET /key/list` → 200. 127 responses under `/peers/<hub>/llm`; 9 were
non-2xx, none 403 and none 5xx:

| Status | Request (under `/peers/<hub>/llm`) | A later identical call got 2xx |
|---|---|---|
| 404 | `GET /ui.txt` | — |
| 307 | `GET /ui` (to `/ui/`) | — |
| 401 | `GET /user/available_users` | no |
| 401 | `GET /health/license` | no |
| 401 | `GET /organization/list` | yes |
| 401 | `GET /team/list` | yes |
| 401 | `GET /get/ui_settings` | yes |
| 307 | `HEAD` on the mount itself, no trailing slash (to the mount with one) | yes |
| 404 | `GET /__next._tree.txt` | — |

The five 401s all come in the first burst right after login, before the dashboard has settled;
three of the same calls succeed moments later. This matches the first-fetch race the Task 7
spike recorded for LiteLLM's UI. Not investigated further here: a plausible cause is those early
calls going out before the UI has read `/.well-known/litellm-ui-config` (and so its key header
name), but that was not measured. The 404s are Next.js probes for files LiteLLM's build does not
ship. A host-browser probe over a direct link, before this run, showed the same non-2xx responses
(it did not record `_next` paths), so they are not relay-specific.

### Step 4 — member refused admin paths

B, a fresh context in the isolated browser, joined in **7 043 ms: `Connected (relay)`** as peer
`12D3KooWPDgJWsntaJsTVSeAcfVWEgJXkBjw2PiKp1ND7NJgZ4B9`. From B's page: `POST …/llm/keys` → **403**,
`GET …/llm/ui/login/` → **403**. B pasted A's key into the Key step, picked `fake`, and got
`"reply to: hello from B (model fake-model)"` in 365 ms.

### Step 5 — revocation

A streamed chat call from B's page returned 200 and reached `[DONE]`. Then
`DELETE /hub/api/members/<B>` through the door. The step then polls B's calls and accepts only a
**403 whose JSON `error`/`reason` contains `revoked`**; a timeout, network error, 5xx or 200 keeps
polling, and 90 s without such a 403 fails the step. B's **first** call after the DELETE answered —
**57 ms later** — was that refusal: **403 `{"error":"membership revoked"}`** (attempt 1, no other
outcomes before it). There was no cache window
to wait out: the hub checks revocation itself on every request (only other peers pull a cached
deny list), so a member's still-valid token is refused at once.

Observation, not a failure: B's page kept showing `Connected (relay)` afterwards (screenshot 3 s
after the failing call). The link indicator does not reflect a revocation; the test did not
check what the chat UI shows when a message is sent after it.

### Step 6 — host browser

C, launched on the host, joined in **1 080 ms: `Connected (direct)`**.

## Link modes observed

| Browser | Where | Mode | Join time |
|---|---|---|---|
| A (admin) | isolated Docker network | **relay** | 7 171 ms |
| B (member) | isolated Docker network | **relay** | 7 043 ms |
| C (member) | host | **direct** | 1 080 ms |

The isolated browsers could not reach the appliance's bridge network and took the relay, as
expected; no WebRTC path (for example via the host's public address) was found from there. The
host browser shares the host with the hub's bridge network and got WebRTC directly.

The hub's member list is not evidence of link mode: it shows each member's advertised addresses
(A and B: none; C: one, a circuit address), not the connection the hub holds.

## Earlier runs the same day

**Run 1 (18:22 UTC).** It passed steps 1–4 and 6 with the same link modes (A relay 7 212 ms, B relay
7 200 ms, C direct 1 096 ms) and failed step 5 at its **baseline** call, before revoking anything:
the test sent a non-streaming chat completion, the test upstream (`test/fake-llm.mjs`) answers only
with SSE, and LiteLLM returned 500 "Empty or invalid response from LLM endpoint". That was a defect
in the test, not the product: the revocation probe now streams, as the chat does. That run left its
member B unrevoked.

**Run 2 (18:23:38–18:24:21 UTC), all six PASS**, previously the recorded run: A relay 7 167 ms,
B relay 7 093 ms, C direct 1 207 ms; step 5's first call after the DELETE (59 ms) answered 403
`{"error":"membership revoked"}`. Its step 5 accepted *any* failure as revocation (the review's
finding); the response it happened to get was the revocation refusal, which is why it is kept as
supporting evidence rather than discarded.

## Keys minted in LiteLLM (not cleaned up)

- `mesh-chat-2026-09-15T18:22:37.317Z` — run 1, admin A
- `mesh-chat-2026-09-15T18:23:54.928Z` — run 2, admin A
- `mesh-chat-2026-09-15T18:34:29.571Z` — recorded run (run 3), admin A
- `phone-test` — minted through the door for the human's phone hand-off (not by `e2e.mjs`)

B's `POST …/llm/keys` (alias `e2e-member-must-be-refused`) was refused by the hub with 403 and
minted nothing.

## Page errors

None in any run.
