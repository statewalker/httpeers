# Deploying httpeers.net

## What it is

The production deployment of the mesh's services on one host: **five containers** — four on a
single `httpeers_edge` network, fronted by Caddy, plus a STUN server on its own published port. Caddy terminates TLS for `*.httpeers.net` and
`*.p.httpeers.net`, plus `cellb.dev` and `*.cellb.dev` (a second domain, served by the same
`sites` app; `www.cellb.dev` redirects to the apex).

| Service | Image | What it is |
|---|---|---|
| `caddy` | `httpeers-ingress` | Publishes `80`, `443`. Holds the certificates (`*.httpeers.net`, `*.p.httpeers.net`, `*.s.httpeers.net`) and routes by `Host`. |
| `relay` | `httpeers-relay` | The circuit relay. Reached through Caddy, never directly. |
| `sites` | `httpeers-sites` | The static-site host, reading from `rustfs`. |
| `rustfs` | `rustfs/rustfs` | S3-compatible storage. One first-level prefix per site. |
| `stun` | `coturn/coturn` (pinned) | STUN only, at `stun:stun.httpeers.net:3478`. Publishes `3478/udp` and `3478/tcp` itself: Caddy cannot proxy UDP. No TURN, no relaying, no credentials. See [The STUN server](#the-stun-server). |

**A second, separate stack runs on the same host**: the LLM appliance (hub, LiteLLM, Postgres,
Traefik) in `/opt/httpeers-llm`, compose project `httpeers-llm`, on its own network and with no
public port. Caddy does not route to it. It is deployed by `.github/workflows/llm-appliance.yml`.
See `llm-appliance/README.md`, "On the httpeers.net server". Nothing in this file changes for it.

## Layout

This file lives beside the three things it describes: `docker-compose.yml`, the
`Caddyfile`, and `ingress/Dockerfile` (Caddy plus the Gandi DNS plugin — a stock Caddy
image cannot solve the DNS-01 challenge below).

| File | What it is |
|---|---|
| `docker-compose.yml` | the five services, their volumes and the `httpeers_edge` network |
| `Caddyfile` | routing by `Host`, the wildcard certificates, the relay's bootstrap document (bind-mounted, not in the image) |
| `ingress/Dockerfile` | Caddy with the Gandi DNS module (`ghcr.io/statewalker/httpeers-ingress`) |
| `.env.example` | `ACME_EMAIL`, `GANDI_BEARER_TOKEN`, `RELAY_ANNOUNCE_ADDRS`, `RELAY_KEY`, `S3_*`, `SITES_CACHE_TTL_MS` |
| `llm-appliance/` | the separate LLM appliance stack |

Images are built by `.github/workflows/relay.yml`, `sites.yml` and `ingress.yml` on a push to
`main` that touches them. The relay and sites workflows then deploy over SSH (`docker compose pull`
and `up -d` in `DEPLOY_PATH`) when the repository variable `DEPLOY_ENABLED` is `true`; the relay
deploy fails if the relay's peerId changed. The ingress image is never deployed automatically,
because restarting it restarts TLS for everything.

**Nothing deploys this file.** No workflow watches `deploy/docker-compose.yml`, `deploy/README.md`
or `deploy/server/`, and none copies the compose file to the server: the deploy jobs run
`docker compose up -d relay|sites` against the server's own copy. A change here — a new service,
such as `stun` — reaches production only when a person copies the file over and starts it
(`deploy/server/README.md`, "Adding a service to the edge stack").

## How to run it

### 1. DNS records at Gandi, once

`admin.gandi.net` → your domain → **DNS records** (the domain must be on **LiveDNS**; if it is
on external nameservers this will not apply). Then **Add**:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| `A` | `*` | `<server ip>` | 3600 |
| `A` | `@` | `<server ip>` | 3600 |
| `A` | `*.p` | `<server ip>` | 3600 |
| `A` | `*.s` | `<server ip>` | 3600 |

The `*` record is the point of the whole design: it points **every** unassigned subdomain at
the server, so publishing a new site needs no DNS change — and with the wildcard certificate,
no Caddy change either. It does not override more specific records, so an explicit
`relay` A record would still win if one ever existed.

The `@` record covers the bare apex `httpeers.net`, which a wildcard does **not** match. Skip
it if the apex is not wanted.

The `*.p` record is for **session origins**, `<name>.p.httpeers.net` (see
`apps/session-shell`). It looks redundant — while `p.httpeers.net` does not exist in the
zone, the `*` record already answers for `abc.p.httpeers.net` — and it is not. Issuing the
`*.p.httpeers.net` certificate writes a TXT record at `_acme-challenge.p.httpeers.net`,
which makes `p.httpeers.net` exist as an *empty non-terminal*; from then on it is the
closest encloser for every session name, the `*` record no longer applies (RFC 4592), and
without `*.p` every session name is NXDOMAIN for as long as the challenge record exists —
at every issuance and renewal, plus negative caching. A side effect of the record: the
bare `p.httpeers.net` stops resolving (NOERROR, no address), which is correct — it is not
a site. The `*.s` record does the same for the test session zone, `<name>.s.httpeers.net`.

**`stun.httpeers.net` needs no record either**: the `*` record answers for it. There is no
`stun` site block, so `https://stun.httpeers.net` serves whatever Caddy serves an unknown name;
only port `3478` means anything there.

Gandi accepts a wildcard record without validating it, so a typo here fails silently at
resolution time rather than at entry. `*.p` is a valid name, and the Personal Access Token below
can create it through the LiveDNS API: its "technical configuration" permission covers A records
as well as TXT.

### 2. A Gandi Personal Access Token, once

A wildcard certificate can only be issued through the ACME **DNS-01** challenge, which means
Caddy must create and delete `_acme-challenge` TXT records in this zone by itself. That needs
an API credential.

**It must be a Personal Access Token.** The `caddy-dns/gandi` module does not accept Gandi's
deprecated API Key. The two are also used differently — a PAT is sent
as `Authorization: Bearer <token>`, an API Key as `Authorization: Apikey <key>`.

In `admin.gandi.net`, under **Account settings** (or the organisation's page, if the account has
more than one organisation) → **Personal Access Token** → **Create a token**:

| Field | Value |
| --- | --- |
| Organisation | the one holding `httpeers.net` |
| Name | max 42 characters, e.g. `caddy-acme-httpeers` |
| Expiration | a real date — see the warning below |
| Scope | restrict it to `httpeers.net` rather than the whole organisation |
| Permission | **Manage domain name technical configurations** — this is the one that grants DNS record writes. It implies *See and renew domain names*; nothing else is needed. |

Do **not** grant anything broader. A token that can also transfer, delete or renew domains turns
a compromise of the reverse proxy into a compromise of the domain itself. The proxy only ever
needs to write and delete TXT records.

The token is displayed **once**, at creation. It cannot be retrieved afterwards — store it in a
password manager as well as in `.env`.

### 3. First start

```sh
cd deploy               # on the server: the deployment directory
cp .env.example .env    # fill in GANDI_BEARER_TOKEN, ACME_EMAIL, RELAY_ANNOUNCE_ADDRS

# The relay's identity volume is declared `external`, so Compose will not
# create it -- and, more to the point, `docker compose down -v` will not
# destroy it. Create it once, deliberately:
docker volume create httpeers_relay_key

# RustFS's data is external for the same reason, and it holds every published
# site:
docker volume create httpeers_rustfs_data

docker compose up -d
```

Open `3478/udp` and `3478/tcp` in the host firewall for the STUN server, next to `80` and `443`
(see [The STUN server](#the-stun-server)).

The relay will refuse to start with no identity. Seed one:

```sh
# on a machine with the repo checked out
pnpm --filter @statewalker/httpeers-relay bootstrap
# copy the printed RELAY_KEY into .env, then
docker compose up -d relay
```

**Back that key up.** It is the relay's identity, it is embedded in every
client's configuration, and there is no other copy.

### 4. Publish a site

Sites live in the `sites` bucket, one prefix per domain. Publishing is writing
files; nothing else brings a site online.

```sh
rclone config create httpeers s3 \
  provider=Other \
  endpoint=https://s3.httpeers.net \
  access_key_id=... \
  secret_access_key=... \
  force_path_style=true

rclone sync ./dist httpeers:sites/abc.httpeers.net --progress
```

`https://abc.httpeers.net` serves it immediately -- no DNS record, no
certificate, no Caddy edit, no restart. A re-published file can take up to
`SITES_CACHE_TTL_MS` to appear; set it to `0` while iterating.

**`p.httpeers.net` is not an ordinary site.** It is the shared session shell: the
`*.p.httpeers.net` block rewrites every session name's `Host` to `p.httpeers.net`, so
all of them read this one prefix. Publish it with `apps/session-shell/scripts/deploy.mjs`,
not by hand — the file order matters while visitors are mid-session. The bare name
`p.httpeers.net` itself does not resolve (see the DNS section).

**`s.httpeers.net` is the same kind of prefix, for tests.** Its block rewrites every
`<name>.s.httpeers.net` to it, and it holds PeerShare's session shell instead of
`apps/session-shell`: PeerShare's Viewer injects `/_shell/ws-shim.js` into every page a
Service returns, and only PeerShare's shell has that file. Without it, a shared app's
WebSockets never connect (the page loads, the shim's `<script>` is a 404).

Optional per-site settings go in `.site/config.json` inside the prefix:

```json
{ "spa": true, "notFound": "/404.html", "cacheControl": "public, no-cache" }
```

That directory is never served.

### 5. After any change to the Caddyfile

The Caddyfile is a bind mount, not part of the image, so a change needs no rebuild — and
no container restart either:

```sh
# validate the new file against the running image, BEFORE it replaces the live one
docker run --rm -e GANDI_BEARER_TOKEN=x -e ACME_EMAIL=x@example.com \
  -v "$PWD/Caddyfile.new:/etc/caddy/Caddyfile:ro" \
  ghcr.io/statewalker/httpeers-ingress:latest caddy validate --config /etc/caddy/Caddyfile
cp -p Caddyfile Caddyfile.bak.$(date +%Y%m%d)
cat Caddyfile.new > Caddyfile          # in place -- see below
docker exec -w /etc/caddy httpeers_caddy caddy reload --config /etc/caddy/Caddyfile
```

**Write it in place.** A single-file bind mount follows the file's inode: `cp`, `scp` or
an editor that writes a new file and renames it over the old one leaves the container
reading the OLD inode, and the reload then applies nothing. `cat new > Caddyfile` keeps
the inode; compare `md5sum Caddyfile` with `docker exec httpeers_caddy md5sum
/etc/caddy/Caddyfile` before reloading.

A reload keeps every connection and certificate; a new site block's certificate is
obtained in the background (for a DNS-01 wildcard, a little over the 2-minute
propagation delay).

## Why it is the way it is

### Two volumes are external, and the certificates live on the host

Two volumes are `external: true` on purpose — `httpeers_relay_key` (the relay's
identity) and `httpeers_rustfs_data` (every published site). `docker compose down -v`
removes every volume it *owns*, and neither of those is recoverable by redeploying.
`caddy_data` is a host volume for a related reason: recreating the container must not
re-issue certificates, because Let's Encrypt's rate limits are per registered domain and
a redeploy loop would exhaust them.

### Wildcards are the whole design

Let's Encrypt via the ACME **DNS-01** challenge, which is the only challenge
that issues wildcards. Renewal is automatic and needs nothing on the host.

`caddy_data` holds the certificates and the ACME account, so recreating the
container does **not** re-issue. Keep that volume: Let's Encrypt's rate limits
are per registered domain, and a redeploy loop that re-issues will exhaust
them.

With the `*` record and the `*.httpeers.net` certificate, publishing a new subdomain changes
nothing here: no Caddyfile edit, no DNS record, no reload. Session origins (`*.p.httpeers.net`)
need one more wildcard, set up once: the `A *.p` record, a Caddy block with its own certificate,
and the shell published to the `p.httpeers.net` prefix.

### The relay's bootstrap document is derived state

The relay writes `/.well-known/httpeers-relay.json` onto the `bootstrap`
volume at startup; Caddy serves it from the `relay.httpeers.net` block. It lets
a peer that knows only the URL learn the peerId to dial and pin. See
[`apps/relay/README.md`](../apps/relay/README.md) for the document and the client contract.

Two things to know operationally:

- **The volume is derived state.** Unlike `httpeers_relay_key` it is not
  `external`, and losing it costs nothing — the relay rewrites the document on
  its next start. `docker compose down -v` is safe for this one.
- **Caddy mounts it read-only.** The relay is the only writer.

After a deploy:

```sh
curl -s https://relay.httpeers.net/.well-known/httpeers-relay.json
```

The `relayAddrs` entry must match the address in `docker compose logs relay`,
peerId included — it is generated from what the relay advertises, so a mismatch
means something is wrong with the volume, not with the configuration.

### The STUN server

`stun` answers STUN Binding requests on `3478`, UDP and TCP, and nothing else. A WebRTC peer
asks it which address it sees the peer as, and offers the answer as its server-reflexive
(`srflx`) ICE candidate — which is what lets two members behind NAT find each other's public
address and connect directly instead of through a relay circuit.

- **STUN only.** `--stun-only` makes coturn ignore every TURN request, and
  `--denied-peer-ip` over all of IPv4 and IPv6 refuses any relay even if that flag were ever
  dropped. No realm, no users (`--no-auth`): a Binding request needs neither, and a server
  that relays nothing has nothing to protect with a password. No TLS (`5349`) for now: that
  needs a certificate, and browsers do not need `stuns:`. The telnet admin console is off
  (coturn's default; `--cli` would turn it on).
- **Its own published ports, not Caddy's.** Caddy proxies HTTP over TCP; STUN is mostly UDP,
  and its whole answer is "the address your packet came from", so it must come straight from
  the host. Docker's port mapping keeps the client's source address for traffic from outside.
- **The image is pinned by tag and digest.** Bump both together, deliberately.
- **It is not on `httpeers_edge`.** Nothing talks to it over that network, and it talks to
  nothing.

#### Firewall

Open, on the host firewall and on any provider-level firewall or security group in front of it:

| Port | Protocol | For |
|---|---|---|
| `3478` | UDP | STUN — what browsers and node-datachannel use |
| `3478` | TCP | STUN over TCP — for networks that drop outbound UDP |

Nothing else: no relay port range, because nothing relays. With `ufw`:

```sh
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
```

**Docker bypasses `ufw`.** It publishes ports through its own iptables chain (`DOCKER`), ahead of
`ufw`'s rules, so `3478` is open to the internet the moment `docker compose up -d stun` runs,
whatever `ufw status` says. The `ufw` rules record intent and matter if Docker's iptables
handling is ever turned off; the provider-level firewall is the one that actually gates it. Check
from **outside** (below), not by reading the rule list.

#### DNS

The `*` A record covers it. From any machine:

```sh
dig +short stun.httpeers.net A        # the server's address -- the same as relay.httpeers.net
dig +short stun.httpeers.net AAAA     # must be empty -- see below
```

**No AAAA for `stun` until Docker IPv6 is configured.** The service binds `0.0.0.0` (IPv4
only), because Docker publishes IPv6 ports only with IPv6 enabled in the daemon and on the
network. A client that resolves an AAAA record would send its IPv6 Binding requests into
nothing — harmless for ICE (that server just yields no IPv6 `srflx` candidate) but a confusing
half-failure. Add a wildcard or `stun` AAAA only together with Docker IPv6 and a
`[::]:3478:3478` port binding.

If the `A` answer differs from `dig +short relay.httpeers.net`, someone added an explicit
`stun` record; it wins over the wildcard.

#### Is it alive?

From a machine **outside** the server's network (from the server itself, a request to
`127.0.0.1` comes back with Docker's bridge address, not yours):

```sh
turnutils_stunclient stun.httpeers.net      # coturn's client (apt install coturn / brew install coturn)
# ... UDP reflexive addr: <your public ip>:<port>
```

On the server, the container's own healthcheck runs the same client against its listener:

```sh
docker compose ps stun                        # (healthy)
docker exec httpeers_stun turnutils_stunclient 127.0.0.1
```

In a browser, the check that matters — a page gets an `srflx` candidate from it. Paste in the
devtools console of any `https://` page:

```js
const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.httpeers.net:3478" }] });
pc.createDataChannel("probe");
pc.onicecandidate = (e) => e.candidate && console.log(e.candidate.type, e.candidate.candidate);
await pc.setLocalDescription(await pc.createOffer());
// expect a line starting "srflx" with your public address; only "host" lines means no answer
```

Or at <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>, with
`stun:stun.httpeers.net:3478` as the only server: a `srflx` row is a working server.

## What will surprise you

> **PATs expire, and certificate renewal will fail silently when it does.** Caddy renews at
> roughly 2/3 of the certificate lifetime, so an expired token surfaces as a certificate that
> stops renewing, weeks before anything visibly breaks. Put the token's expiry date in a
> calendar with a reminder well ahead of it. This is the single most likely way this deployment
> fails months from now.

**A 404 here means the relay is not running.** The document is deleted before
every start attempt and written only once the relay is up, so a crash-looping
relay serves nothing rather than pointing peers at a relay that is down. Check
`docker compose logs relay` before touching anything else.

**If the relay refuses to start with `could not write the bootstrap
document`,** the volume is not writable by the container's unprivileged user.
The image chowns `/srv/bootstrap` to `node`, which Docker copies into an empty
named volume — but a volume created earlier, or a bind mount, keeps the
ownership it already has. Either fix the ownership or unset
`RELAY_BOOTSTRAP_PATH` to stop publishing the document; the relay treats a
failure to write as fatal, because a healthy relay whose document is silently
absent is a failure nobody notices until peers cannot reach it.

### `cellb.dev` needs a second Gandi token

`*.cellb.dev` is issued over DNS-01 with `GANDI_CELLB_BEARER_TOKEN`, a PAT scoped to
`cellb.dev` only (same permission as the httpeers.net one). The httpeers.net token cannot do
it: the LiveDNS API answers `403` for `cellb.dev`. The apex and `www` use HTTP-01 and need no
token. The variable is passed to Caddy in `docker-compose.yml`, so adding or rotating it means
recreating the container (`docker compose up -d caddy`), not a reload — a reload keeps the
old environment. Both tokens expire; renewals fail silently when one does (see above).

### Checking `relay.httpeers.net` does not test the wildcard

Checking `relay.httpeers.net` is **not** a test of the wildcard. It has its own
site block, so Caddy manages a certificate for that exact name — it can be
perfectly valid while the wildcard is broken or absent. Test a name that
appears in no site block and no DNS record:

```sh
openssl s_client -connect <server ip>:443 -servername nonesuch.httpeers.net </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
```

The SAN list must contain `*.httpeers.net`.

Session origins have a certificate of their own (`*.httpeers.net` matches one label and
does not cover `abc.p.httpeers.net`). Check it the same way, with a name nothing has used,
and check the DNS answer too:

```sh
dig +short nonesuch123.p.httpeers.net          # the server's address
openssl s_client -connect <server ip>:443 -servername nonesuch123.p.httpeers.net </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -ext subjectAltName   # must list *.p.httpeers.net, issuer Let's Encrypt
```

Run the `dig` again **during** an issuance or renewal (`docker compose logs caddy | grep
'p.httpeers.net'`): that is when a missing `*.p` record would show up, as NXDOMAIN.
`apps/session-shell`'s `pnpm run live-check` does all of this with fresh random names.

## Reference

| Command | What it does |
|---|---|
| `docker compose up -d` | start or update everything |
| `docker compose pull relay && docker compose up -d relay` | what the relay deploy job runs (same for `sites`) |
| `docker compose logs relay` | the relay's peerId and addresses |
| `curl -s https://relay.httpeers.net/.well-known/httpeers-relay.json` | the published relay address |
| `docker exec -w /etc/caddy httpeers_caddy caddy reload --config /etc/caddy/Caddyfile` | apply a Caddyfile change |
| `pnpm --filter @statewalker/httpeers-session-shell live-check` | DNS, TLS and HTTP checks for session origins, with fresh names |
| `docker compose up -d stun` | start or update the STUN server |
| `turnutils_stunclient stun.httpeers.net` | the STUN server answers, from outside |
