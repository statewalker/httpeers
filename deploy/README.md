# Deploying

Two containers on one host: Caddy holding the certificates, and the relay.

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

The `*` record is the point of the whole design: it points **every** unassigned subdomain at
the server, so publishing a new site needs no DNS change — and with the wildcard certificate,
no Caddy change either. It does not override more specific records, so an explicit
`relay` A record would still win if one ever existed.

The `@` record covers the bare apex `httpeers.net`, which a wildcard does **not** match. Skip
it if the apex is not wanted.

Gandi accepts a wildcard record without validating it, so a typo here fails silently at
resolution time rather than at entry.

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

## Adding the static-site host later

One line in the `Caddyfile`: the `*.httpeers.net` block's `respond` becomes
`reverse_proxy sites:3000`. No new certificate, no DNS record, no other change.
