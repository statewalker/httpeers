# ADR-0013: Where the platform defines a behaviour, the platform is the specification

**Date:** 2026-08-20
**Status:** Accepted

## Context

`AbortSignal` semantics were recorded as unspecified in the stack and untested — the
one gap in an otherwise-proven block. The question was posed as a design choice
between propagating cancellation to the remote handler and abandoning locally.

It is not a design choice. `fetch` accepts a signal; a real HTTP server observes a
client disconnect as `Request.signal` firing. The mesh's entire premise is that an
unmodified third-party SDK can run over it, which is a claim about being
indistinguishable from the platform.

## Decision

Where the Fetch and Streams standards define a behaviour, the standard is the
specification and httpeers derives its answer rather than inventing one.

Applied to the case at hand: a request accepts a signal, aborting cancels the call,
the response body errors as the standard requires, and the remote handler's
`Request.signal` fires — because that is what a client disconnect does to an HTTP
server.

Where the platform is silent, or where a behaviour is meaningless over a mesh, the
specification says so explicitly and states what happens instead. Silent divergence
is the failure this ADR exists to prevent.

## Consequences

A class of future questions is answered in advance — header casing and multiplicity,
null-body statuses, HEAD, body reuse, half-close — by citation rather than by
argument, and the acceptance criteria for them are already written by someone else.

The divergences become a short, explicit list instead of an unbounded set of small
surprises. That list is a required section of the specification.

Conformance gains an outside standard to be measured against, which is a stronger
claim than internal consistency.
