# ADR-0012: Typed errors at the kit, HTTP status at the edge

**Date:** 2026-08-20
**Status:** Accepted

## Context

T-2 states the problem exactly: nothing says what a caller observes for peer offline,
protocol unsupported, stream reset, relay data-limit exceeded, or timeout — they
surface as assorted exceptions — and there is no timeout or retry policy anywhere.
Every application built before this exists invents its own, differently.

The system's central bet is that ordinary `fetch()` works over the mesh, and `fetch`
has two failure vocabularies: a `Response` when the origin answered, a throw when it
did not.

One distinction must survive whatever is chosen: *"the peer answered 503"* and *"we
never reached the peer"* are different facts, and an application that retries the
first but not the second has to tell them apart.

## Decision

Outbound calls at the kit level throw typed, transport-free errors. The classes cover
offline, unsupported protocol, stream reset, timeout, over-limit and refused, and a
concrete transport failure is wrapped, never discarded.

The edge — and only the edge — maps those classes to HTTP statuses, so `fetch()`
behaves the way `fetch()` behaves. The mapping is exhaustive and stated in the
specification rather than chosen per edge, and a synthesized response is
distinguishable from one the peer actually sent.

Retryability is a property of the error class, stated per class, not a decision each
application re-derives.

## Consequences

Three edges cannot ship three different mappings, which is the T-2 problem
reproduced one level up and the reason the mapping does not live in the edges.

An application reading only `response.status` still behaves sensibly; one that needs
the distinction has a marker to read rather than a body to parse.

A timeout policy has to exist for the timeout class to be meaningful, so the request
timeout becomes part of the specified contract rather than a tuning knob with no
stated semantics.
