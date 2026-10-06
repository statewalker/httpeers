# ADR-0019: Biscuit is the token format and Datalog is the policy language

**Date:** 2026-08-21
**Status:** Accepted
**Supersedes:** the `.access` tree of ADR-0007 §6.4 as the policy *mechanism* (its
immutable-value and atomic-swap properties survive unchanged)
**Reshapes:** ADR-0010, ADR-0016, ADR-0017

## Context

Reviewing `google/sam` — a zero-config zero-trust libp2p mesh for agents, Apache-2.0
and explicitly not an official Google product — surfaced a system solving this problem
class on the same substrate, and it uses [Biscuit](https://github.com/biscuit-auth/biscuit):
a public-key-verified token with **offline attenuation** and a Datalog authorization
language.

Two things followed. The first was independent convergence on decisions taken here:
SAM's baseline check is

```datalog
check if client_peer_id($id), connection_peer_id($id);
```

which is ADR-0009's binding rule written in Datalog. SAM pins the issuer key at
enrollment and verifies offline thereafter (ADR-0018), rotates keys with a grace
period (ADR-0008 amendment), and denies by default (P3). Another team, same substrate,
same rules.

The second was a mechanism this design did not have. Biscuit's defining property is
that *"a new, valid token can be created from another one by attenuating its rights, by
its holder, without communicating with anyone."* Blocks chain and each may only
restrict.

Separately, the `.access` tree had accumulated: a root→leaf walk, inheritance,
deeper-may-widen, per-method sub-entries, and a distinct vocabulary with transitive
`implies`. Five mechanisms where Datalog has one, and in Datalog transitivity is simply
what a rule does.

## Decision

**Biscuit is the token format.** It carries identity facts, the binding, expiry,
audience restriction (ADR-0020) and the delegation chain (ADR-0010 amendment).

**Datalog is the policy language**, replacing the `.access` tree. A node holds rules
and policies; a request is authorized by an authorizer evaluating them against the
token's facts plus facts the node asserts about itself and the request.

**The token carries roles; the node holds the rules.** The hub mints identity and role
facts. Each node owns the rules deriving capabilities from roles, and the policies
governing its own resources. Nothing remote influences a decision — ADR-0016's property
is preserved exactly, now expressed as rules rather than as a separate structure.

**Evaluation is bounded.** An authorizer runs under a hard time budget. SAM's figure —
a 1 s ceiling against a ~0.14 ms nominal cost — is the right shape: a ceiling far above
any legitimate evaluation, present so that a pathological one cannot become a denial of
service.

## Consequences

**Block A's policy half drops from DERIVED to DESIGNED, and this is a real loss.**
Prototype 07 (tree walk, inheritance, explicit deny) and prototype 09 (vocabulary with
transitive `implies`) no longer describe the implementation. Their *properties* remain
requirements — deny by default, no privilege creep, an unknown role granting nothing,
explainable denials — but the running evidence behind them stops being evidence for
what ships. Prototype 03 is unaffected: it is about binding, not tree shape.

**Explainability changes shape rather than disappearing.** Biscuit reports which checks
failed and which policy matched, so a denial is attributed to a failed check rather than
to a governing directory. P8 is reworded, not weakened.

**Unknown constraints become fail-closed by construction**, which is why ADR-0017 is
subsumed rather than implemented (see its amendment).

**A WASM dependency enters the browser bundle.** `@biscuit-auth/biscuit-wasm` is the
JavaScript path, and at the time of writing it is version 0.6.0, last published roughly
nine months ago, with upstream Go v2 support still listed as sought. This risk was
raised, weighed and accepted; it is recorded here rather than discovered later. It is
mitigated by the codec seam in ADR-0005's amendment and by pinning an exact version.

**Authoring changes for everyone.** A policy author writes Datalog rather than JSON.
That is more expressive and, for anything conditional, considerably shorter — and it is
a language to learn where the tree was a shape to read.
