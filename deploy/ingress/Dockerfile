# The ingress image: Caddy, plus the one module it cannot do without here.
#
# WHY A CUSTOM IMAGE AT ALL. Stock Caddy compiles in no DNS providers, so it
# cannot perform the ACME DNS-01 challenge -- and DNS-01 is the only challenge
# Let's Encrypt will issue a WILDCARD certificate for. Without this image
# there is no *.httpeers.net certificate, and every new static site would need
# its own certificate, its own Caddyfile entry, and a place in Let's Encrypt's
# 50-certificates-per-registered-domain-per-week budget.
#
# Both tags are pinned. `caddy:builder` and `caddy:latest` drifting
# independently would mean a module built against one runtime and shipped with
# another.

FROM caddy:2.10-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/gandi

FROM caddy:2.10-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
