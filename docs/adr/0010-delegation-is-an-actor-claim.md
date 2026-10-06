# ADR-0010: Delegation is a reserved actor claim, enforced when a product needs it

**Date:** 2026-08-20
**Status:** Accepted
**Supersedes:** the 2026-08-20 first draft of this ADR, which specified enforcement
from the first release on a cost argument that did not survive scrutiny.

## Context

The record recommends the reverse proxy peer as the first real application: it works
today, exercises forwarding against a genuine product surface, and delivers the
flagship case — reach a private service from a browser with no VPN, no tunnel and no
firewall rules. It works only where the proxy speaks *as itself*.

Everything beyond that wants delegation. ADR-0009 makes the reason structural: a
forwarded token's confirmation key names the caller, so the next hop's binding check
fails, correctly.

### The cost argument that was wrong

The first draft of this ADR justified enforcing delegation immediately by claiming
that adding an actor concept later "means reissuing every token in circulation".

It does not. If the claim is optional and its absence means "no delegation", existing
tokens carry no actor and behave exactly as before. Nothing is reissued.

The real retrofit cost is **verifier skew**: a verifier that does not know the claim
*ignores* it, and then a token meaning "the proxy acting narrowly for Alice" is read as
"Alice, fully" — a privilege escalation caused by an unknown field being ignored.
During any rollout window, un-upgraded verifiers are exploitable.

That cost is removed entirely by ADR-0017. With critical-claim marking, a verifier
that cannot process the actor claim **rejects the token** rather than misreading it.
Three treatments exist, not two — ignore (dangerous), reject (a safe deferral),
enforce — and the first draft conflated the first two, which is what made deferral look
expensive.

With the skew hole closed, the remaining consideration points the other way. The
record calls delegation *undesigned* and *a design task, not a prototype*. Specifying
its policy semantics now means designing them in the abstract, with no product to
falsify them against.

## Decision

The actor claim is **reserved and marked critical**, and **enforcement is deferred**
to the reverse proxy that needs it.

Concretely, now: the claim is registered in the token contract, it names the subject
acted for and the actor's own confirmation key, and it is always critical — so a
verifier lacking support rejects any token carrying it. No verifier ever ignores it.

Concretely, later: minting, policy semantics, and the access-decision distinction
between "Alice" and "the proxy acting for Alice" are designed alongside the reverse
proxy, and a policy silent about delegation denies it, consistent with deny-by-default.

The token shape is fixed now precisely so it does not have to change then.

## Consequences

The reverse proxy ships in the shape that already passes — acting as itself, with its
own roles — and gains delegation when its own design has something to say about it.

Delegated tokens cannot be minted or accepted until enforcement lands. A token
carrying the claim is rejected everywhere in the interim, which is the intended
behaviour and is testable.

An audit in the interim records "the proxy did it" and cannot record for whom. That
limitation is stated, bounded, and ends when enforcement ships.

Chained delegation remains out of scope. The shape admits one actor, and whether
nesting is ever permitted is a question the product designing enforcement inherits.

---

## Amendment, 2026-08-21 — delegation is pre-authorized offline attenuation

Reviewing `google/sam` surfaced a third mechanism that was not on the menu when this
ADR was decided, and it is better than an actor claim on the axes that matter here.

Biscuit's defining property is offline attenuation: a holder can derive a strictly
narrower token *without contacting the issuer*, and the block structure makes widening
impossible rather than merely forbidden.

Applied here, delegation becomes: **Alice narrows her own token and binds the narrowed
copy to the delegate's key.** No hub round trip, works while the hub is unreachable,
and the party choosing the narrowing is the one who knows what the delegate actually
needs. Least privilege by construction instead of by policy review.

### The tension, and how it resolves

Peer-binding and attenuation-delegation are in direct conflict. Bind a token to a
connection and it cannot be given to anyone — that is the point of ADR-0009. SAM hit
this and resolved it by giving up delegation entirely: every bearer fetches its own
token from the control plane, bound to its own peer id.

The resolution taken here is the one SAM did not take: **the hub pre-authorizes
delegation in the authority block.** The block carries the terms under which the token
may be re-bound — whether at all, to what depth, within which capability subset, and
under what lifetime cap. Attenuation then happens offline, afterwards, within those
terms. Verification walks the chain hub → Alice → delegate, checking each block's
signature and that each step only narrows, with the final binding naming the delegate's
key.

A token whose authority block permits no delegation cannot be delegated. That is the
default, and it is deny-by-default expressed in the format rather than in policy.

### What is unchanged, and what is superseded

The decision to **reserve now and enforce later** stands. The reverse proxy still
designs enforcement against a real surface, and the record's judgement that delegation
is a design task rather than a prototype is unaffected.

What changes is the mechanism reserved. The `act` claim is superseded by the
attenuation chain: instead of the hub minting a token naming an actor, the hub grants
permission to attenuate and the holder exercises it.

Chained delegation stops being out of scope by omission and becomes a bounded
parameter — depth is a term in the authority block, so "one hop" and "no delegation"
are the same mechanism at different settings.

---

## Amendment, 2026-08-21 — a plain attenuation block is not enough

The amendment above says a holder "appends a block naming the delegate and narrowing
what may be done, **signed with the holder's own key**". Prototype 10 established that
Biscuit's plain `appendBlock` does not do that, and that assuming it does is a
privilege escalation.

Appended blocks are signed with a next-key that travels **with the token**. Anyone
holding the token bytes can therefore append a block, and that block attests to nothing
about who wrote it.

The consequence is not theoretical. Every peer Alice calls receives her token — that is
how a bearer credential works. If delegation were permitted by a bare `delegate` fact,
any of those peers could append `delegate(itself)` and wield her authority. The
mechanism intended to *narrow* authority would instead hand it to every peer she ever
talked to.

## The correction

Delegation requires a **third-party block**, signed by the holder's own device key, and
the authority block's check must **scope** the delegate fact to that key:

```datalog
check if bound($k), connection_peer($k)
      or delegate($k), connection_peer($k) trusting ed25519/<holder-device-key>;
```

Only a block signed by the named key can supply a trusted `delegate` fact. The presence
of that second alternative is what permits delegation at all, so a token minted without
it cannot be delegated — deny by default, still expressed in the format rather than in
policy.

Prototype 10 demonstrates both halves, and both are required: T10-08 refuses a thief's
forged plain block, T10-09 accepts Alice's signed third-party block. A change that made
T10-09 pass while T10-08 also passed would be the escalation, silently.

## Consequences

The hub must know the holder's **device signing key** at mint time, since it is named in
the authority block's scope. That key already exists — it is the same key the binding
names — but it now appears in the token as a public key rather than only as an
identifier string.

Delegation is bound to a device, not to a subject. A holder can delegate only from the
device whose key the authority block scoped, which is consistent with ADR-0009 and
narrows the blast radius of a stolen token to no delegation at all.

Reserved-not-enforced is unchanged. What changed is the mechanism reserved, and it
changed because something ran.
