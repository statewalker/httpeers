# ADR-0011: Forwarding is a policy decision, and the hop limit is part of the contract

**Date:** 2026-08-20
**Status:** Accepted

## Context

Prototype 06 exists because a review — not a test — found that the router enforced
access only on the local branch, so any peer could ask any other peer to forward on
its behalf. An open relay. The remedy made refusal happen *before any dial*, which
the prototype asserts by checking the dial counter is zero.

The remedy was a construction-time boolean, `allowRelay`. The record notes that A-3's
principle — *roles describe people, capabilities are what code checks* — implies this
should instead be a capability in the vocabulary, "which A-3 implies but did not do".

Separately: **no hop limit exists anywhere in the system.** It is harmless while no
peer forwards, and the record names it a precondition for shipping any peer that
does, because forwarding peers can form a cycle.

## Decision

Forwarding is authorized through the access tree like every other action. The caller
must hold the forwarding capability; a peer may therefore forward for some callers
and not others, and each refusal returns `{ allowed, source, reason }` and is
explainable by someone who did not write the policy.

The decision is still taken before any dial, so prototype 06's criterion continues to
hold and becomes a numbered acceptance check.

A hop counter with a hard default ceiling is part of the request contract, not a
deployment option. Exceeding it is a defined error class, not a hang.

## Consequences

`allowRelay` disappears as a peer-level flag. A peer that wishes to forward for
everyone grants the capability broadly; the general case is now expressible, whereas
the boolean admitted only all-or-nothing.

Forwarding stops being the one authorization decision in the system that policy
cannot see and an audit cannot explain.

A cycle becomes unshippable rather than merely inadvisable, and the limit is testable
without building a real relay topology.
