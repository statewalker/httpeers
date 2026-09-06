# Deploying

Two containers on one host: Caddy holding the certificates, and the relay.

## DNS, once

At Gandi, in the `httpeers.net` zone:

```
*.httpeers.net   A   <server ip>
httpeers.net     A   <server ip>     # only if the apex is wanted
```

The **wildcard A record is the point**: with it, publishing a new subdomain
needs no DNS change, and with the wildcard certificate it needs no Caddy
change either.

Then create a Gandi **Personal Access Token** — the older API Key auth is
discontinued and the `caddy-dns/gandi` module will not accept one. Scope it to
managing DNS records in this zone only.

## First run

```sh
cp .env.example .env    # fill in GANDI_BEARER_TOKEN and ACME_EMAIL
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
