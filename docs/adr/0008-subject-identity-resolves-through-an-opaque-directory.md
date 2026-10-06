# ADR-0008: Subject identity is opaque to core and resolved through a directory seam

**Date:** 2026-08-20
**Status:** Accepted

## Context

Splitting core from the transport (ADR-0005) forced the question of what a subject
identifier *is*. Today `sub`, `ProvenPeer` and `PeerIdStr` are bare strings whose
meaning comes entirely from libp2p, and `verifyToken` recovers the issuer's public
key from the peerId itself.

Self-certifying identifiers keep the "every peer is its own certificate authority"
property with no third party and no network on the verification path. They have one
disqualifying limitation: **an identity that is its own key can never rotate that
key.** A leaked key ends the identity permanently. This is not hypothetical — browser
peer keys live in IndexedDB per origin, so clearing site data is already
indistinguishable from becoming a new peer.

## Decision

Subject identifiers are opaque to core. Core compares them and passes them; it never
parses one.

Keys are obtained through an injected directory seam:

```
resolve(subjectId) => Promise<VerifyingKey | null>
```

Nothing else is in the contract. Caching, negative caching and batching are internal
to an implementation and invisible to its callers — a directory that caches and one
that does not are indistinguishable through this API, so no caller can depend on
either.

`null` or a thrown error denies. There is no permissive fallback and no stale path.

A self-certifying implementation — one that parses the key out of the identifier and
never touches the network — is a conforming implementation of this seam.

## Consequences

Key rotation becomes possible, which self-certifying identifiers foreclose.

The costs are accepted deliberately: verification is asynchronous and may touch the
network; a resolver outage is an authorization outage rather than a degradation; and
the directory is a trusted party whose compromise expands access in the *permissive*
direction — the same failure shape the record already flags for the unsigned
vocabulary, and the more dangerous direction than version skew.

The binding rule is no longer necessarily a string comparison. The proven peer is
transport-shaped and the subject may not be, so the mapping between them is
security-critical and must be specified rather than assumed. This is the sharpest
open item this ADR creates.

Block A becomes testable with a fixture key pair and a stub resolver, with no
transport present.

---

## Amendment, 2026-08-20 — the directory resolves issuers, not subjects

Writing the verification chain out concretely showed the seam was stated one
identifier too wide. Only the **issuer** signs a token, so only the issuer's key is
ever needed to verify one. A subject's key is never consulted: the subject is proven
by the confirmation claim (ADR-0009), which is compared against what the transport
already proved, not resolved.

The seam is therefore:

```
resolve(meshId) => Promise<VerifyingKey[]>
```

An empty result denies, as `null` did. It returns a set rather than one key so that a
rotation can publish the new key alongside the old for an overlap window, which a
single-key signature cannot express.

This is a strict narrowing of the decision above, not a reversal: identifiers stay
opaque to core, resolution may still look up, and caching stays invisible to callers.

It also delivers more than key rotation for members. It makes **hub key rotation**
possible, and the record lists recovering from a compromised hub as having no answer
at all — *"the mesh **is** the hub's peerId; nothing here can revoke it."* Separating
the mesh's identifier from the mesh's current signing key is precisely what removes
that. A member losing its device key needs no directory at all: its confirmation
claim changes and the hub mints it a new token.
