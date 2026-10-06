# ADR-0005: The transport boundary is a package boundary, and token verification is transport-free

**Date:** 2026-08-20
**Status:** Accepted

## Context

Block T's stated value is not its code but its boundary: *nothing above T may import
a libp2p type*. Block R is specified as pure and isomorphic with zero transport
imports.

`@statewalker/httpeers.core` enforces this at file level, with an isolation grep
test permitting exactly two files to import libp2p. The discipline is real, but the
two permitted files are `transport-duplex.ts` (block T, legitimate) and
`tokens.ts` — **block A**, which imports `@libp2p/crypto/keys` and
`@libp2p/peer-id` to recover an issuer's public key from a peerId, step 1 of the
five-step verification chain.

At package level the boundary therefore does not hold. Importing the router installs
`@libp2p/tcp`, `yamux` and `noise`; block A cannot be built or tested without a
transport it never uses; and a browser bundle is separated from a TCP stack only by
tree-shaking. ADR-0004 in `webrun-wire` names six transports for the Duplex seam —
libp2p, WebRTC, WebSocket, MessagePort, LiveKit, PeerJS — and the in-process double
is what makes the isomorphism claim falsifiable rather than merely asserted.

## Decision

Two packages, split on the T seam.

- **`@statewalker/httpeers.core`** — blocks R, A and M. Isomorphic. No transport in
  its dependency graph, direct or transitive.
- **`@statewalker/httpeers.libp2p`** — block T. The libp2p node profiles, the
  Duplex adapter, and the concrete crypto.

Token verification stops importing libp2p. It takes two injected seams: a resolver
from a subject identifier to a verifying public key, and a signer. The libp2p
implementations of both live in the transport package and are passed in.

## Consequences

Block A becomes testable with a fixture key pair and no network stack, which is what
the eight prototype-level token criteria will be written against.

The isolation grep is replaced by something stronger: core's `package.json` simply
has no transport dependency to import, so the boundary is enforced by resolution
rather than by a test that a contributor can delete.

A second transport becomes a package rather than a fork. That is the claim ADR-0004
in `webrun-wire` makes for the Duplex seam, extended one layer up.

The identifier that a token's `sub` names is now transport-shaped by convention
rather than by type. The specification must state what a subject identifier is
independently of libp2p, or the seam leaks its only implementation back through the
string format.

---

## Amendment, 2026-08-21 — the token format is a seam too

ADR-0019 adopts Biscuit, whose JavaScript path is a WebAssembly module. Placing that in
`httpeers.core` would put WASM in every browser bundle that imports the router.

The remedy is the one this ADR already established for the transport: make it a seam.
`Signer` and `Directory` are already injected; a **`TokenCodec`** seam joins them,
covering minting, attenuation, and verification-with-an-authorizer. The Biscuit
implementation lives in `@statewalker/httpeers.biscuit` and is passed in.

This ADR's literal claim is unaffected — core has no *transport* in its dependency
graph, and the boundary is still enforced by resolution. The spirit takes a knowing hit:
a peer that authorizes anything must now load a WASM module somewhere in its graph. That
cost was raised, weighed and accepted in ADR-0019, and the seam is what keeps it out of
core and out of anything that only routes.

It also keeps the format replaceable. A token format adopted for one property —
offline attenuation — behind a seam can be reconsidered without touching the router,
the mounts or the peer composition, which matters more than usual given the maturity
concern ADR-0019 records.
