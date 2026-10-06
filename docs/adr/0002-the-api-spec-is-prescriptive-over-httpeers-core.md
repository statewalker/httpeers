# ADR-0002: The API specification is prescriptive over `httpeers.core`

**Date:** 2026-08-20
**Status:** Accepted

## Context

`@statewalker/httpeers.core` exists and is under active construction in a parallel
session (Task 8 of 19 at the time of writing), exporting `createPeer`,
`createPeerRouter`, `createMounts`, tokens, stores, access tree, vocabulary,
revocation and an error taxonomy. It was derived from the same nine prototypes this
specification is derived from.

Two surfaces derived from one body of evidence will diverge unless one of them is
authoritative. The alternative readings were: describe what `httpeers.core` is
becoming (zero rework, but the API is whatever the plan happened to produce), or
build a facade above it (no rework, two surfaces to keep in sync forever).

The evidence that accretion is already happening: `CreatePeerInit` carries twenty
fields, several of which exist to defend against mis-pairing other fields
(`accessTree`/`vocabulary` must be supplied together or not at all, enforced by a
constructor throw). A field that exists to guard another field is a shape that was
grown, not designed.

## Decision

This specification is the target API. `httpeers.core` is an implementation of it and
is refactored where it diverges.

Divergences are recorded as they are found, each with the reading the specification
takes and why, rather than being silently absorbed in either direction.

## Consequences

Rework lands on the in-flight `httpeers-stack` session. The divergence list is
therefore part of the deliverable, not an appendix — it is what makes the cost
visible and schedulable instead of arriving as surprise churn.

The specification must earn its authority. A prescriptive document that is merely
different from working code is worse than no document; each divergence has to name
the defect in the current shape it removes.
