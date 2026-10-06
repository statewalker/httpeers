# ADR-0007: Mounts and policy are immutable values, swapped atomically

**Date:** 2026-08-20
**Status:** Accepted

## Context

Whether `provide()` supports hot-reload was recorded as an open design question, and
prototype 05 covers no unmount or replace. Separately, the `.access` file loader is
unbuilt with a hard requirement that a malformed policy file **fail closed** —
untested, because there is nothing to test.

The use cases already on the table are dynamic: pairing as a mounted resource, agent
and tool endpoints, and `site-builder`'s pattern of dynamic-importing a server module
served by the same site — which the record names as a plausible answer to "how does a
peer ship code to another peer". Policy also changes far more often than code does.

Individually mutable operations (`remove`, `replace`, `reload`) each open a window in
which the table is half-updated. For policy, a half-updated tree is a fail-open
window, which is the one failure direction this system does not tolerate.

## Decision

Mount tables and access policy are immutable values, validated whole at build time.
A peer holds a reference to the current one, and reconfiguration replaces that
reference atomically.

A reload that fails validation throws and the previously installed configuration
stays in force. Failing closed is therefore structural: there is no code path that
installs a partially-parsed policy, so no check has to be remembered.

Requests in flight complete against the configuration they started with.

## Consequences

Hot-reload is available without any per-operation semantics for "what happens to a
request during unmount" — the question does not arise.

ADR-0006's refuse-duplicates rule stays trivially true, because every table is
validated as a unit before it can be installed.

Reconfiguration allocates a whole table rather than mutating one entry. For tables of
the size a peer mounts, this is not a cost worth designing around.
