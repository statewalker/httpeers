# ADR-0017: Critical claims are marked, and a verifier never ignores one

**Date:** 2026-08-20
**Status:** Accepted

## Context

A token claim that grants or narrows authority is dangerous in a specific way: a
verifier that does not understand it will *ignore* it, and ignoring a narrowing claim
widens authority. The delegation claim is the immediate case — a token meaning "the
proxy acting narrowly for Alice", read by an older verifier as "Alice, fully" — but it
is a property of the class, not of that claim.

This is what governs whether any future claim can be introduced into a running mesh
safely, and therefore whether a feature can be deferred at all. It was never put as a
question while ADR-0010 was decided, which is why that ADR's first draft reached for
"enforce immediately" as the only safe option.

The two obvious rules each fail in one direction. Rejecting every unknown claim is
safe and makes each new claim a breaking change requiring the whole mesh to upgrade
first. Ignoring every unknown claim — JWT's default — upgrades smoothly and is exactly
the escalation hole above.

## Decision

A token marks which of its claims are critical, in the manner JWT defines as `crit`.

A verifier **rejects** a token carrying a critical claim it cannot process, and
**ignores** unknown non-critical claims.

Every claim that grants, narrows or qualifies authority is critical. Descriptive
claims are not. The actor claim is critical by construction.

## Consequences

A feature can be reserved in the token contract and enforced later without a rollout
window in which un-upgraded verifiers are exploitable. This is what makes ADR-0010's
deferral safe rather than merely convenient, and it applies to every claim added
after this one.

Adding a critical claim still requires coordination — verifiers must support it before
it is minted. That coordination is now explicit and enforced by rejection, instead of
implicit and enforced by nothing.

The marking must be integrity-protected along with the claims themselves; a mark an
attacker can strip converts a critical claim back into an ignorable one and restores
the whole hole.

Deciding criticality is a judgement made per claim, at design time, and getting it
wrong in the permissive direction is a security defect. Every claim this
specification defines states its criticality explicitly rather than leaving it to be
inferred.

---

## Amendment, 2026-08-21 — subsumed by Biscuit's checks, and improved by them

ADR-0019 adopts Biscuit, which achieves this ADR's goal structurally and closes the
residual risk recorded above.

This ADR existed because a verifier that does not understand an authority-granting
claim *ignores* it, and ignoring a narrowing claim widens authority. Critical marking
was the remedy, and its stated weakness was that the marking must itself be
integrity-protected — a mark an attacker can strip converts a critical claim back into
an ignorable one.

In Biscuit, constraints are `check if` clauses and **all of them must pass**. A check
referring to a predicate a verifier never supplies simply does not hold, so the token is
rejected. Unknown constraints are fail-closed by construction, with nothing to mark and
therefore nothing to strip.

The rule this ADR states remains true and is now enforced by the format rather than by
a field: a verifier never ignores a constraint it does not understand.

What survives as a discipline rather than a mechanism: deciding, per constraint, whether
it belongs in the token as a check. A constraint expressed as a bare fact that nothing
checks is inert, and that is the modern form of the mistake this ADR was written to
prevent.
