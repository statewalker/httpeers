---
"@statewalker/webrun-biscuit": minor
"@statewalker/httpeers-access": patch
---

webrun-biscuit: add a revocation check (`isRevoked`, `revokedId`, `assertNotRevoked` with `RevokedTokenError`, and `VerifiedBiscuit.isRevoked`), a printer (`VerifiedBiscuit.print()`, `printBlock`, and the exported `printRule`/`printCheck`/`printPolicy`/`printPredicate`/`printTerm`), and the `Datalog` tagged-template builder (`datalog\`…\``) that binds every interpolated value as a parameter. httpeers-access now uses that builder instead of its own copy.
