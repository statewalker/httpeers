# ADR-0023: The relay describes itself, and nothing else

**Date:** 2026-09-07
**Status:** Accepted

## Context

A peer needs a relay's **peerId** before it can dial it, because the identity is part
of the multiaddr and Noise verifies it. Until now that meant compiling the peerId into
every client, or distributing it as an invitation payload — which works, and which
makes the relay's identity a build-time constant for everyone who uses it.

The relay is also the one component in the system defined by what it does *not* do: it
serves nothing, holds no directory, and announces itself as a member of nothing.
`p2p-demo` violates this by calling `serveDiscovery()` inside its relay, and the stack
design names that as a thing not to copy.

Two questions therefore arrive together. May the relay publish enough for a peer to
reach it from a bare URL? And — since a relay is where peers meet — should it also tell
them about each other?

## Decision

The relay publishes a document describing **itself**, at a well-known path:

```json
{ "relayAddrs": ["/dns4/<host>/tcp/443/tls/ws/p2p/<peerId>"] }
```

It **writes** the file; the ingress **serves** it. The relay still answers no requests.
This is within the no-application-code rule rather than an exception to it: the relay
already printed its peerId and addresses to stdout at startup, and this is the same
act, one destination further.

**It carries no information about other peers.** No directory, no registry, no
rendezvous, no discovery. A peer uses the document to reach the relay; it then dials
other peers by peerIds it already holds, obtained by some other means.

The document is generated from `node.getMultiaddrs()` — never from the configuration
that produced those addresses.

The public key gets no field of its own. Ed25519 keys are 32 bytes, below libp2p's
42-byte inlining threshold, so the peerId embeds the verifying key and it is
recoverable from the string alone.

## Consequences

A client can carry a **list of relay URLs** instead of compiled-in identities. Relays
can be added, replaced or rotated without rebuilding clients.

**Trust becomes pin-on-first-use, and its failure mode inverts.** Before the first
fetch, trust rests on DNS and the certificate authority. After pinning, it equals a
configured peerId. But a compromised first contact pins the *attacker's* identity
permanently — and the fail-loud rule then fires against the **legitimate** relay. That
is not "degraded to no pinning"; it is locked to the attacker while loudly rejecting
the real one. A deliberate, human-initiated re-pin path is therefore mandatory, and it
must never be triggered by the relay, the document, or a field inside it.

The blast radius is bounded by what a relay is trusted with: peer↔peer Noise runs
inside the circuit and the target peerId stays in the dialed address, so a substituted
relay can deny service and observe traffic patterns but **cannot read what flows
through**. This reasoning does not transfer to the hub, whose peerId *is* the mesh
identity.

Generating from `getMultiaddrs()` makes drift structurally impossible. Generating from
configuration would have created a second source of truth for the relay's address —
the exact failure ADR-0022's announce-address requirement exists to prevent,
reintroduced through the mechanism meant to make bootstrapping easier.

**Discovery remains unanswered, deliberately.** The relay gives dialability, not
enumeration. Finding peers stays the hub's problem, and a peer that has no peerId to
dial is no better off than before. Solving it here would have duplicated the component
that exists to solve it.
