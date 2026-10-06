# ADR-0004: A peer is constructed from grouped concerns, not a flat option bag

**Date:** 2026-08-20
**Status:** Accepted

## Context

`CreatePeerInit` carries twenty fields. They sort cleanly into three concerns that
have nothing to do with each other:

- **identity / node** — `node`, `listen`, `privateKey`, `selfPeerId`, `protocol`
- **policy** — `mounts`, `accessTree`, `vocabulary`, `hubPeerId`,
  `usesTransportIdentity`, `revocationCache`, `allowRelay`
- **tuning** — `drainTimeoutMs`, `maxStreams`, `requestTimeoutMs`,
  `maxConcurrentOutbound`, `now`

An application author writes the middle group and nothing else, but must read past
the other two to find it.

The flat shape has already produced a defect it has to defend against at runtime:
`accessTree` and `vocabulary` must be supplied together or not at all, because a
custom tree evaluated against a defaulted vocabulary fails *open*. The current
constructor throws when exactly one is present. That guard is the diagnosis: a flat
bag has no structure that makes the pairing evident, so it needs a runtime check to
say what a type could have said.

## Decision

`createPeer({ identity, policy, tuning })`.

- `identity` accepts either an already-started node or a listen specification, never
  a mixture whose precedence has to be documented.
- `policy` is the only group an application author writes. The access tree and its
  vocabulary are one value, `{ tree, vocabulary }`, so supplying one without the
  other is unrepresentable and the constructor guard disappears — the type carries
  the invariant instead of a throw.
- `tuning` defaults as a named profile and is absent from every example an
  application author reads.

Every constituent — router, mounts, access tree, vocabulary, tokens, revocation —
stays individually exported. `createPeer` is a composition of the kit, not a wall
in front of it, so an author who needs a shape it does not offer drops one level
rather than forking.

## Consequences

Callers of the current flat `CreatePeerInit` must be rewritten. The mapping is
mechanical, and the `accessTree`/`vocabulary` guard and its test are deleted rather
than ported — a test for an unrepresentable state is dead weight.

Grouping resists future accretion: a new knob has to name which concern it belongs
to, and one that fits none of the three is a signal that the peer is being asked to
do something it should not.
