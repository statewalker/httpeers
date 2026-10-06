# ADR-0016: The vocabulary is local and authoritative; publication is read-only

**Date:** 2026-08-20
**Status:** Accepted

## Context

A-3 established the split: roles describe people, capabilities are what code checks.
Policy names only capabilities, so renaming or splitting a role touches no `.access`
entry. Roles are namespaced, additive across a union, and an unknown role grants
nothing — never a fallback.

The open item is trust. A node's role→capability mapping is local and unsigned, and
the record is specific about the direction of failure: a tampered vocabulary expands
roles in the **permissive** direction, unlike version skew, which degrades safely.
The designed endpoint `/{peerId}/.well-known/capabilities` was never built.

## Decision

A node's vocabulary is its own value, constructed locally. No verifier consults a
remote vocabulary when deciding access — there is therefore nothing on the permissive
path to tamper with, and no signing scheme is required to protect a document nobody
trusts.

`/.well-known/capabilities` publishes the mapping behind the same access middleware
as everything else, for discovery, debugging and the explainability of a denial. It
is read-only in the strict sense: what it returns never influences a decision, on the
publishing node or on any other.

A typo in a vocabulary throws at construction, and the error lists every problem
rather than the first. `std:` is reserved for the mesh protocol; applications use
their own prefix, so a future protocol capability cannot collide with an existing
application one.

## Consequences

"Roles are coarse; capabilities are local" stays literally true rather than being a
description of an implementation detail that a distribution mechanism would quietly
overturn.

The issuer minting roles and the provider enforcing them can disagree, and the system
tolerates it in the safe direction: an unknown role grants nothing. That is the
designed behaviour, not a gap.

Mesh-wide agreement on capability names is a governance problem, not a protocol one.
It stays open, and it stays out of the code.

---

## Amendment, 2026-08-21 — the vocabulary is a rule set

ADR-0019 replaces the `.access` tree with Datalog. The vocabulary is not lost in that
move; it stops being a separate structure and becomes what it always described — rules
deriving capabilities from roles, held by the node.

Transitive `implies` disappears as a feature because transitivity is what a rule does.
A role granting a capability, and a role implying another role, are one mechanism.

Every property this ADR decided survives, and the reason it decided them is unchanged:

- The rules are the **node's own**. No verifier consults a remote vocabulary, so there
  is nothing on the permissive path to tamper with and no signing scheme is needed for
  a document nobody trusts.
- The token carries **roles**, not resolved capabilities. Issuer and provider may
  disagree, and the system degrades in the safe direction: an unknown role derives no
  capability, because no rule fires for it. That is deny-by-default falling out of
  evaluation rather than being asserted separately.
- `/.well-known/capabilities` still publishes the mapping, still read-only, and what it
  returns still influences no decision anywhere.

The alternative — the hub resolving roles into capabilities and embedding them, which
is what `google/sam` does — was considered and rejected for the reason this ADR
originally gave: it moves capability decisions to the issuer, which is the
permissive-on-tamper direction.

Validation still fails closed and still lists every problem. A policy referencing a
capability no rule can derive is a defect caught when the rule set is built, not a
silent permanent denial at request time.
