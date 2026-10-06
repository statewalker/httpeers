# ADR-0015: Intermediary header hygiene is one exported transform

**Date:** 2026-08-20
**Status:** Accepted
**Follows from:** ADR-0014

## Context

ADR-0014 makes the transport a pass-through that holds no opinion about headers. That
is correct for a transport and it leaves an obligation unowned.

A peer that re-issues a received message as a real HTTP call *is* an HTTP
intermediary. RFC 9110 forbids an intermediary from forwarding hop-by-hop headers —
`Connection`, `Keep-Alive`, `TE`, `Transfer-Encoding`, `Upgrade`,
`Proxy-Authorization`, and anything the `Connection` header names. Forwarding them
produces real, hard-to-diagnose failures against real servers.

The concrete leak is worse than the protocol violation. A browser calls a mesh peer
with its membership token in `authorization`. That peer is the reverse proxy — the
product the record recommends building first — and it re-issues the message to a
local service: Home Assistant, Ollama, a printer. Passed through unjudged, the mesh
membership token is delivered to a service that has no business holding it and every
opportunity to log it.

## Decision

Core exports one intermediary transform, and any peer that re-issues a received
message must apply it. It removes hop-by-hop headers per RFC 9110, consumes the
mesh's own authorization rather than forwarding it, and sets the forwarding headers
an intermediary is expected to set.

It carries its own numbered acceptance criteria and is verified independently of any
product that uses it.

## Consequences

The obligation is met once. T-2's lesson — that anything left to each application is
implemented by each application differently — has already been paid for once in this
project, and hygiene is a worse thing to get individually wrong than a timeout policy.

The transport stays dumb, which ADR-0014 requires, while the intermediary role stays
correct.

A peer with genuinely unusual forwarding needs must compose around the transform
rather than skip it, and if that proves too rigid the fix is to parameterise the
transform, not to make it optional.

---

## Amendment, 2026-08-21 — the transform also supplies the upstream credential

This ADR made the transform *remove* things: hop-by-hop headers, and the mesh
membership token that must never reach an upstream service.

`google/sam`'s Secure Outbound Gateway does the other half. Having verified the caller,
it **injects** the credential the upstream actually requires, looked up by destination
host, so that "agent sandboxes never see the real API keys". Its configuration is a map
from host to credential kind and value — bearer token, basic auth, or a named custom
header.

Removal without supply leaves an obvious gap. Every real upstream a reverse proxy fronts
— a home automation hub, a model endpoint, a printer — wants *some* credential, and an
author who has just been told not to forward the caller's token will otherwise reach for
the nearest thing to hand, which is an environment variable read inside a handler.

The transform therefore takes a credential source keyed by destination, and supplying
the upstream credential is part of re-issuing a message rather than something a product
arranges separately. The credential never crosses the mesh, and it never appears in a
handler.

This preserves the property that makes the reverse proxy worth building first: an
unmodified third-party service sits behind the mesh with zero changes to that service,
including its authentication.
