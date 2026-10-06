# ADR-0009: The binding rule is a confirmation-key claim

**Date:** 2026-08-20
**Status:** Accepted
**Supersedes the rule stated in:** the identity model (`sub === proven peer`)

## Context

The binding rule is the load-bearing rule of the trust model: a token is valid only
when presented over a connection whose proven peer matches the token's subject. Both
checks, always. Possession without membership is anonymous; membership without
possession is a stolen token.

It was implemented as string equality between `sub` and the Noise-proven peerId,
which works precisely because `sub` *is* a transport key. ADR-0008 allows a subject
to be a directory-issued identifier that outlives any particular key, which removes
the equality and, with it, the proof that membership and possession refer to the same
party.

## Decision

The token names the identity in `sub` and, separately, the transport key it is bound
to in a confirmation claim (the shape RFC 7800 defines as `cnf`).

The binding check becomes: the confirmation key equals the proven peer. It remains a
single comparison, performed offline, with no directory call on the request path.

## Consequences

Multi-device is answered without new mechanism: one token per device, each bound to
that device's own key. The parked question — *does a device's role inherit from its
user, or can it be narrower?* — is resolved in favour of "either", since a
device-bound token carries its own roles and may carry fewer than its user's.

Key rotation works: the subject persists while the confirmation key changes.

Forwarding a caller's token verbatim now fails *by construction* rather than by
convention. The forwarded token's confirmation key names the caller; the next hop
proves the proxy's key; binding fails. This is the correct outcome and it is why
ADR-0010 exists.

The two hub handlers permitted to read the proven peer as a source rather than as a
guard — `/invite` and the presence check-in — are unaffected: both operate before a
token exists.

---

## Amendment, 2026-08-20 — revocation revokes device keys, not only subjects

Binding a token to a device key created a gap the original decision did not close:
**there was no way to remove one device.** Revocation carried `sub` only, so
withdrawing a compromised phone meant revoking its owner — and every other device that
owner holds.

That gap is the strongest practical argument for making a directory authoritative over
subject→device keys, since a central registry removes a device by deleting a row. The
argument is answered without the directory: revocation already exists, already pulls
and caches, and already sits *ahead* of the request path rather than on it.

A revocation entry therefore names a subject **or** a confirmation key. Revoking a
subject withdraws all of its devices; revoking a confirmation key withdraws exactly
one, leaving that subject's other tokens valid.

Removal is bounded by the revocation cache interval rather than immediate. That is the
entire cost, and it buys keeping verification offline, keeping the hub off the
authorization path of every request, and keeping two peers on a partitioned network
able to verify each other.

The two mechanisms answer different questions and neither replaces the other:
`cnf` answers *"was this token issued to the device presenting it?"* — offline, always
available. Revocation answers *"is that device still allowed?"* — pulled, cached, and
current to within one interval.
