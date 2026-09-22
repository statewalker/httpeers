# The manual remote check

`e2e.mjs` (`--local` or against the server) never measures real NAT traversal: its browsers run
on this machine, and a same-host run reports `direct` or `relay` for reasons that say nothing
about a real second network (see `e2e/README.md`, point 4 of "Against a locally prepared
appliance"). This is the one procedure that does. It has no automated gate — a human runs it, by
hand, against a real second network, and records what happened.

**This document is the procedure only.** It does not itself contain a result. The result, once
this procedure has actually been run, belongs in `RESULTS.md`, in a section headed clearly as
**manual**, dated, with the client network named.

## Who can run this

**Anyone with a phone or a second machine on a network genuinely different from this appliance's
host.** No special access to this repository beyond what running the appliance already needed.

## The two acceptable clients

- **A phone, on mobile data, with Wi-Fi turned off.** Confirm Wi-Fi is off before starting, not
  just "not connected to this network" — a phone on the *same* Wi-Fi as the appliance host proves
  nothing about NAT traversal, because it never leaves the LAN. Turning off Wi-Fi entirely is the
  only way to be sure the phone's traffic actually crosses onto the mobile carrier's network.
- **A VM on another network** — a cloud instance, a machine at another site, anything that is not
  behind the same router as the appliance host and is not on a VPN that tunnels back through it.

Either is sufficient. Do not substitute a browser tab on the same LAN, a browser in a different
Docker network on the *same host* (that is what `e2e.mjs` already does and does not count), or a
VPN that routes back through the appliance's own network.

## Prerequisites on the appliance host

- The appliance is up (`docker compose ps` — six services healthy; see `../README.md`).
- `bin/invite.sh` works from this directory (needs `.env` and `data/hub/hub.env` — both exist once
  the appliance has been brought up at least once).
- `ADMIN_USER`/`ADMIN_PASSWORD` from `.env`, to read `GET /hub/api/members` afterwards.
- A way to get the invitation to the remote client: show its QR code to the phone's camera, or
  copy/paste the blob text over a channel that isn't the appliance's own network (a messaging app,
  email, reading it aloud) — see "Transfer the blob", below, for why the link is not what's being
  tested here.

## Procedure

1. **Mint a member invitation**, from `deploy/llm-appliance` on the appliance host:

   ```sh
   ./bin/invite.sh --roles member --ttl-days 1
   ```

   This writes `invites/<date>-member/blob.txt` (the blob, the primary artifact), `blob.png` (a QR
   code of that same blob, already round-tripped through this repo's own decoder before the script
   exits), and `link.txt` (a convenience link — not used in this procedure, see below).

2. **Transfer the blob, not the link.** The point of this check is that an invitation is a blob a
   client can redeem however it travels — test that path, not the `?join=` link shortcut:
   - **QR**: open `blob.png` on a screen the remote client's camera can see (or, on the same
     screen, open the admin UI's own invite panel and read its QR — same blob, same mechanism).
   - **Copy/paste**: send `blob.txt`'s contents to the client over a channel outside the
     appliance's own network — the client will paste the raw text, not click a link.

3. **On the remote client**, with Wi-Fi off (phone) or on the other network (VM), open
   `https://llm-chat.httpeers.net/mesh.html` — the deployed page (`HUB_JOIN_PAGE_URL` in `.env`;
   use whatever page this appliance is actually configured to point invitations at if it differs).
   Confirm the page loaded over the client's own remote network, not a cached copy.

4. **Join**: in the join widget, either
   - press **"Scan a QR code"** and point the camera at the QR from step 2, or
   - paste the blob text into the **"Paste an invitation"** field and press **"Join"**.

   **Record the wall-clock time from pressing Join (or completing the scan) to the page showing
   `Connected (…)`.** This is "time to join".

5. **Mint or receive a key.** If the invitation was `admin`, press "Request a key" on the page
   itself. If it was `member` (as minted above), have an admin mint one for this member from
   another device already on the mesh ("Key for a member" in the chat header, or `bin/invite.sh`'s
   sibling flow described in `../README.md`, "LLM keys") and paste it into the client's Key step.

6. **Send one message.** Type anything (e.g. "hello") and send it.

7. **Read a streamed reply.** Watch the reply arrive incrementally (not all at once) and complete.
   **Record the wall-clock time from sending to the first visible token appearing** — this is
   "first-token latency". It does not need lab precision; a phone's own clock or a stopwatch is
   enough, and the SSE-derived measurements in `../BACKENDS.md`/`../BENCHMARK.md` already exist for
   precise, same-host numbers. This number is about the *shape* (does a real remote client see a
   response start promptly, or stall), not a benchmark to compare against those.

## Reading the negotiated transport afterwards

The page's own connection indicator (`Connected (relay)` / `Connected (direct)`, recorded already
in step 4) is one read of the transport, from the client's side. Get the hub's own, authoritative
view too, from the appliance host:

```sh
curl -s -u "$ADMIN_USER:$ADMIN_PASSWORD" \
  "http://127.0.0.1:${APPLIANCE_DOOR_PORT:-8080}/hub/api/members" | jq
```

Find the row whose `peerId` matches the client that just joined (the admin UI also lists this) and
read its `link` field: `"direct"` (an unlimited connection — WebRTC worked), `"relay"` (a
limited/relay-circuit connection), or `null` (no open connection at all, right now). Read this
**after** the chat exchange above has completed, not immediately at join: the hub keeps a failed
WebRTC upgrade's connection open for roughly 12 seconds after the member has already fallen back to
relay, so a sample taken too early can misreport `direct` for a member that is actually on `relay`
(measured and documented in `RESULTS.md`'s 2026-09-15 run).

## What to record in `RESULTS.md`

Append a new section, headed as a **manual** result, with:

- **Date** (and, if useful, local time) the check was run.
- **Client network**: exactly what was used — "iPhone, Wi-Fi off, [carrier] mobile data" or "VM on
  [provider/region], not on the appliance's network or VPN".
- **Transport**: the page's own indicator from step 4, and the hub's `link` field from the
  `/hub/api/members` read above — both, since they can (briefly) disagree.
- **Time to join** (step 4).
- **First-token latency** (step 7).
- **Any failure, verbatim**: the exact error text or behavior observed (a stuck spinner, a timeout,
  a wrong page, a silent hang) — copy it exactly, do not paraphrase into "it didn't work". If it
  fails, that is the result; do not retry silently until it passes and report only the pass.

## Expected, not a fault: the relay circuit on a home-NAT host

**On a Docker host behind a home NAT (the default `compose.yml`, bridge-networked), the normal
outcome is `relay`, not `direct`.** WebRTC needs a path the NAT will forward, and the default
bridge network gives it none; falling back to the relay circuit is `README.md`'s documented,
expected behavior for this configuration ("Host networking" and "Troubleshooting" in
`../README.md`), not a bug in the appliance or in this check. A `direct` result on a home-NAT host
would actually be the surprising outcome, worth double-checking rather than celebrating. On the
httpeers.net server, which has a public address, members have measured `direct` through the same
kind of bridge network (see the 2026-09-18 server run in `RESULTS.md`) — so `relay` vs. `direct`
here is a property of the host's own networking and public reachability, not of this appliance's
code.

## What this check does not replace

- It is not a load test, a latency benchmark, or a substitute for `BACKENDS.md`/`BENCHMARK.md`'s
  measured, same-host numbers — those remain the precise figures.
- It does not need to be repeated on every code change; it is evidence that the mesh's relay
  fallback and WebRTC path work for a real remote client at all, not a regression gate `e2e.mjs`
  runs on every commit.
- A single successful (or failed) run is one data point, on one client, one network, one day. If it
  fails, the exact failure recorded here is what the next attempt should start from.
