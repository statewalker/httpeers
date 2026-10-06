# ADR-0003: Acceptance criteria are numbered falsifiable checks

**Date:** 2026-08-20
**Status:** Accepted

## Context

The specification must say what "correct" means for each block. Prose criteria
("the router respects segment boundaries") cannot be failed on purpose, and a
criterion that cannot fail cannot be tested.

The project already has the pattern: `@statewalker/webrun-streams-conformance`
defines L0–L5 as a suite every transport implementation must pass, and each of the
nine prototypes carries a README stating what is verified, how it is established,
what would make it fail, and what it does not cover.

## Decision

Every block's acceptance criteria are numbered, block-prefixed checks — `T-01`,
`R-04`, `A-11` — each stating what must hold and what observation would falsify it.
Each maps one-to-one onto a future conformance test.

Criteria derived from a prototype cite it. Criteria with no implementation behind
them are marked as predictions.

An executable `@statewalker/httpeers-conformance` package is deliberately *not*
built now: it cannot be written before the interfaces settle, and writing it against
an unsettled surface would make the surface hard to change at exactly the moment
change is cheapest.

## Consequences

The numbering is a stable reference. A criterion may be superseded but is never
renumbered, so a note, a commit message or a review comment citing `A-11` still
resolves.

The conformance package becomes a mechanical follow-on: one test per numbered
check, with the specification's own text as the test name.
