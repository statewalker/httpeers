# @statewalker/httpeers-access

## 0.2.0

### Minor Changes

- ad4e554: `ruleSet` takes `facts`, an application's own fact vocabulary (`name` or `name/arity`), and `params`, values bound as terms in rules and policies. `authorize` takes those facts as `RequestFacts.extra`; undeclared predicates stay refused in both places, and a rule cannot derive a declared fact. `RuleSet.facts` lists the declaration. Predicate and role detection now ignore text inside string literals.
- 31d6746: Add `MeshRevocationCaches`, a revocation checker for a broker that verifies tokens of several meshes: one `RevocationCache` per mesh, chosen by the token's `mesh` claim, so a subject revoked in one mesh is still accepted in another.
- e3b74ee: `mintToken` takes `facts`: extra authority facts (`[predicate, ...terms]`, bound as parameters, never checks; the predicates in `RESERVED_TOKEN_PREDICATES` are refused). `verifyToken` returns them as `facts` on its `VerifiedClaims`, read from the authority block alone, so an appended block cannot add or override them. The field is absent when a token carries none.

### Patch Changes

- ab7b167: webrun-biscuit: add a revocation check (`isRevoked`, `revokedId`, `assertNotRevoked` with `RevokedTokenError`, and `VerifiedBiscuit.isRevoked`), a printer (`VerifiedBiscuit.print()`, `printBlock`, and the exported `printRule`/`printCheck`/`printPolicy`/`printPredicate`/`printTerm`), and the `Datalog` tagged-template builder (`datalog\`…\``) that binds every interpolated value as a parameter. httpeers-access now uses that builder instead of its own copy.
- Updated dependencies [ab7b167]
  - @statewalker/webrun-biscuit@0.3.0

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-core ^0.1.3 -> ^0.1.4

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
  - @statewalker/httpeers-core@0.1.3
  - @statewalker/webrun-biscuit@0.2.3
