# ADR-0001: The API is decomposed by block, not by layer

**Date:** 2026-08-20
**Status:** Accepted

## Context

httpeers has two decompositions on record. The layer map (L0 transport,
L1 fetch-over-stream, L2 router, L3 access, L4 edges, L5 apps) answers "what calls
what". The block map (note 01, 2026-08-16) answers a different question: "what has
to be built, tested and replaced as a unit", under the criterion *a block is code
that changes together and can be replaced wholesale without touching the others*.

They do not coincide, in two places that matter. L0 and L1 merge into **T**: once
fetch-over-stream is bought, the reasons L0 changes and the reasons L1 changes are
the same reasons — a libp2p version bump, a transport configuration change, a relay
behaviour. And L5 splits into **E**, **M** and **P**: a hub, a client SDK and a demo
have unrelated change drivers.

An API defined along layer lines would put a seam where nothing is ever replaced and
omit one where things are replaced constantly.

## Decision

The API surface is defined per block — T, R, A, E, M, P — at two depths:

- **T and E** get *boundary contracts* only: what may cross the seam. T's contract
  includes the negative rule that nothing above T may import a libp2p type.
- **R, A and M** get full APIs: signatures, usage examples and numbered acceptance
  criteria.
- **P** gets usage recipes, not a surface.

Each block's section states whether its API is **derived** (generalized from a
prototype that runs) or **designed** (no implementation exists yet). T, R and A are
derived. E and M are designed and are labelled so, in place, so no reader mistakes
speculation for evidence.

## Consequences

The package decomposition question is now separable from the API question: blocks
fix the seams, and whether they ship as one package or six is a packaging decision
that cannot silently change a boundary.

`@statewalker/httpeers.core` currently spans R, A, M and part of T in one module
tree. Under this ADR that is a packaging choice to be justified, not a boundary.

Marking M as *designed* means its acceptance criteria are predictions. The first
hub to run will invalidate some of them, and that is the expected cost of defining
it before building it.
