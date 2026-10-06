# ADR-0018: The mesh key is pinned at pairing and rotations are chained

**Date:** 2026-08-20
**Status:** Accepted
**Refines:** ADR-0008

## Context

ADR-0008 accepted a directory that may look up, taking on the cost that the directory
becomes a party whose compromise expands access in the *permissive* direction. As
written, that compromise is total: publish an attacker's key as the mesh's key and the
attacker mints any token for anyone.

Examining whether device keys should also live in the directory surfaced an asymmetry
that decides both questions. **Issuer keys have an escape that device keys do not.**

An issuer key is a single value per mesh, changing rarely, and changing *additively*
during a rotation overlap. That makes it pinnable. Device keys change constantly and
by removal, which is precisely what cannot be pinned — a pin that must be revised
whenever a phone is replaced is not a pin.

## Decision

A peer records the mesh's verifying key when it pairs, and thereafter accepts a new
mesh key only when the replacement is signed by the key it replaces.

The directory becomes a **distribution channel for self-authenticating updates**, not
a trust root. What it serves is verified against the pinned chain before it is
believed; a directory that lies is detected rather than obeyed.

Device keys are deliberately *not* subject to this mechanism. They are authorized by
the confirmation claim (ADR-0009) and withdrawn by revocation (ADR-0009 amendment),
neither of which involves the directory.

## Consequences

Compromising the directory yields nothing. The trust base returns to what the design
intended — the mesh's own key, learned once, at pairing.

Trust-on-first-use moves the risk to the pairing moment, which is the one moment a
human is present and an out-of-band channel exists. That is the right place for it,
and it is where invitation redemption already happens.

A broken chain — a mesh key lost rather than rotated — cannot be repaired from inside.
Recovery means re-pairing every peer. This is the mechanism's real cost and it is
accepted: the alternative is a directory that can silently replace the mesh.

Two keys with different change profiles now have two different mechanisms. That is
not an inconsistency to be tidied away; it is the reason the mechanisms differ, and
merging them would forfeit exactly this ADR.
