# Deploying

**Four containers on one host**, on a single `httpeers_edge` network:

| Service | Image | What it is |
|---|---|---|
| `caddy` | `httpeers-ingress` | The only service with published ports (`80`, `443`). Holds the certificates (`*.httpeers.net`, `*.p.httpeers.net`) and routes by `Host`. |
| `relay` | `httpeers-relay` | The circuit relay. Reached through Caddy, never directly. |
| `sites` | `httpeers-sites` | The static-site host, reading from `rustfs`. |
| `rustfs` | `rustfs/rustfs` | S3-compatible storage. One first-level prefix per site. |

**A second, separate stack runs on the same host**: the LLM appliance (hub, LiteLLM, Postgres,
Traefik) in `/opt/httpeers-llm`, compose project `httpeers-llm`, on its own network and with no
public port. Caddy does not route to it. It is deployed by `.github/workflows/llm-appliance.yml`.
See `llm-appliance/README.md`, "On the httpeers.net server". Nothing in this file changes for it.

This file lives beside the three things it describes: `docker-compose.yml`, the
`Caddyfile`, and `ingress/Dockerfile` (Caddy plus the Gandi DNS plugin — a stock Caddy
image cannot solve the DNS-01 challenge below).

**Two volumes are `external: true` on purpose** — `httpeers_relay_key` (the relay's
identity) and `httpeers_rustfs_data` (every published site). `docker compose down -v`
removes every volume it *owns*, and neither of those is recoverable by redeploying.
`caddy_data` is a host volume for a related reason: recreating the container must not
re-issue certificates, because Let's Encrypt's rate limits are per registered domain and
a redeploy loop would exhaust them.

## Gandi, once

Two things at Gandi, and neither is ever touched again: the DNS records, and a token that lets
Caddy prove control of the zone.

### 1. The DNS records

`admin.gandi.net` → your domain → **DNS records** (the domain must be on **LiveDNS**; if it is
on external nameservers this will not apply). Then **Add**:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| `A` | `*` | `<server ip>` | 3600 |
| `A` | `@` | `<server ip>` | 3600 |
| `A` | `*.p` | `<server ip>` | 3600 |

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
a site.

Gandi accepts a wildcard record without validating it, so a typo here fails silently at
resolution time rather than at entry. (`*.p` is accepted as a name: created through the
LiveDNS API on 2026-09-18 with the same Personal Access Token Caddy uses — its
"technical configuration" permission covers A records as well as TXT.)

### 2. The Personal Access Token

A wildcard certificate can only be issued through the ACME **DNS-01** challenge, which means
Caddy must create and delete `_acme-challenge` TXT records in this zone by itself. That needs
an API credential.

**It must be a Personal Access Token.** Gandi's older **API Key is deprecated**, and the
`caddy-dns/gandi` module does not accept one. The two are also used differently — a PAT is sent
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

> **PATs expire, and certificate renewal will fail silently when it does.** Caddy renews at
> roughly 2/3 of the certificate lifetime, so an expired token surfaces as a certificate that
> stops renewing, weeks before anything visibly breaks. Put the token's expiry date in a
> calendar with a reminder well ahead of it. This is the single most likely way this deployment
> fails months from now.

## First run

```sh
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

The relay will refuse to start with no identity. Seed one:

```sh
# on a machine with the repo checked out
pnpm --filter @statewalker/httpeers-relay bootstrap
# copy the printed RELAY_KEY into .env, then
docker compose up -d relay
```

**Back that key up.** It is the relay's identity, it is embedded in every
client's configuration, and there is no other copy.

## Certificates

Let's Encrypt via the ACME **DNS-01** challenge, which is the only challenge
that issues wildcards. Renewal is automatic and needs nothing on the host.

`caddy_data` holds the certificates and the ACME account, so recreating the
container does **not** re-issue. Keep that volume: Let's Encrypt's rate limits
are per registered domain, and a redeploy loop that re-issues will exhaust
them.

### Verifying the wildcard actually works

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

## The relay's bootstrap document

The relay writes `/.well-known/httpeers-relay.json` onto the `bootstrap`
volume at startup; Caddy serves it from the `relay.httpeers.net` block. It lets
a peer that knows only the URL learn the peerId to dial and pin. See the
repository `README.md` for the document and the client contract.

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

## Changing the Caddyfile

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

## Publishing a site

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

Optional per-site settings go in `.site/config.json` inside the prefix:

```json
{ "spa": true, "notFound": "/404.html", "cacheControl": "public, no-cache" }
```

That directory is never served.
