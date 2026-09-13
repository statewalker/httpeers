# @statewalker/httpeers-conformance

Every prototype in the ladder, rebuilt against the **published** API of the eight packages, and
compiled. `tests/consumers.ts` is never executed — a missing export, a narrowed parameter or a type
that moved surfaces here as a compile failure rather than in wave 5.

Private. Never published, and nothing depends on it.

## Why this is its own package

It used to live in `httpeers-core/tests/prototypes/`, which made `httpeers-core` devDepend on all
seven siblings — and every one of them depends on core. pnpm tolerates a devDependency cycle;
**turbo does not**, and refused to run any task across the workspace:

```
x Cyclic dependency detected:
| @statewalker/httpeers-access#build, @statewalker/httpeers-libp2p#build,
| @statewalker/httpeers-member#build, ... @statewalker/httpeers-core#build
```

A check that depends on everything has to be a **leaf**. Here it is one: it devDepends on all eight
and nothing depends on it, so the graph is acyclic and `turbo test` works again.

**To reverse:** move `tests/` back under `httpeers-core`, restore the seven `workspace:*`
devDependencies there, and delete this directory. The cycle comes back with it.

## What it does not do

It is not a runtime conformance suite. Behaviour is tested in each package, against its own source.
This answers one question only: *can the things that already exist be built on the API as
published?*
