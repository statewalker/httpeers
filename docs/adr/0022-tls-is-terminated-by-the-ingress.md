# ADR-0022: TLS is terminated by the ingress, not by the peer

**Date:** 2026-09-07
**Status:** Accepted
**Amends:** `docs/superpowers/specs/2026-08-18-httpeers-stack-design.md` §9, §13

## Context

The stack design had Node terminate TLS itself — `@libp2p/websockets` accepts
`{ cert, key }`, verified against the installed package — and explicitly rejected "a
system Caddy", a tunnel, and SSH forwarding. Certificates were to come from
`TLS_CERT`/`TLS_KEY`, "renewed externally".

*Renewed externally* was the whole problem. Nothing owned renewal, and a certificate
that stops renewing is the failure that arrives at 3am on a 90-day timer. Deployment
also wanted a **wildcard** certificate, which only the ACME DNS-01 challenge issues,
and DNS-01 means holding a DNS-write credential — something a peer process has no
business doing.

## Decision

A reverse proxy holds the certificates and terminates TLS. Peers speak plain protocols
on an internal network and bind no host port.

The peer's own TLS-terminating code path is **retained** for local runs, for the same
reason ADR-0021 retains `pnpm start`.

## Consequences

**Listen and announce addresses diverge, and that is the sharp edge.** A peer behind a
proxy binds one address and must advertise a different one. libp2p advertises what it
listens on unless told otherwise, so a peer that does not set announce addresses runs,
reports healthy, and is undialable by everyone — with a symptom that points at the
peer's health rather than at its advertised address. Any peer deployed this way must
fail to start rather than advertise an unreachable address.

The proxy becomes a component with its own lifecycle: a custom image, because stock
Caddy compiles in no DNS providers and therefore cannot answer DNS-01 at all.

One wildcard certificate covers every name, so the number of names stops interacting
with the certificate authority's rate limits.

The DNS-write credential lives with the proxy and nowhere else, scoped to one zone's
records.
