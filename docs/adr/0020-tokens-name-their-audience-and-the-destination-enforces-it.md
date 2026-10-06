# ADR-0020: A token names its audience, and the destination enforces it

**Date:** 2026-08-21
**Status:** Accepted

## Context

httpeers tokens carry no audience. A member's token is valid at **every peer in the
mesh**.

This is not a replay hole: ADR-0009's binding already prevents a peer that receives a
token from presenting it elsewhere, because the confirmation key names the original
holder and the next hop would prove a different key. What is missing is *least
privilege*. There is no way to mint a token usable only against the peer it was
obtained for, so the blast radius of any compromise is the whole mesh.

`google/sam` addresses this with `allowed_targets`: the issuer seals a token with a
target restriction, and the **destination** independently injects facts about its own
identity and enforces that it is among the permitted targets —

```datalog
check if allow_network_target($fact, $val) or target_unrestricted();
```

The load-bearing detail is *who checks*. The receiving peer verifies it was an intended
recipient, rather than trusting that whoever routed the request respected the
restriction.

## Decision

A token may name its audience: the peers, or classes of peer, it may be presented to.
An unrestricted token is a distinct, explicit state, not the absence of a field.

The **destination** enforces it, by asserting facts about its own identity and
evaluating them against the token's restriction. A peer that is not an intended
audience refuses regardless of how the request reached it.

## Consequences

Least privilege becomes expressible: a token obtained to talk to one peer cannot be
used against another, so a compromised peer holding a caller's request cannot widen its
reach even in collusion with a faulty router.

This is defence in depth against the failure prototype 06 exists for. Forwarding is
authorized at the forwarding peer (ADR-0011); audience is enforced at the destination.
A bug in either is caught by the other.

Restriction is by identity *or* by class, which means a class predicate — group,
role, label — is evaluated at the destination against facts the destination asserts
about itself. Those facts are therefore security-relevant and must be as trustworthy as
the node's own policy.

Adding an audience later would have meant reissuing tokens to gain the protection.
Adding it now costs a field.
