---
"@statewalker/httpeers-access": minor
---

`mintToken` takes `facts`: extra authority facts (`[predicate, ...terms]`, bound as parameters, never checks; the predicates in `RESERVED_TOKEN_PREDICATES` are refused). `verifyToken` returns them as `facts` on its `VerifiedClaims`, read from the authority block alone, so an appended block cannot add or override them. The field is absent when a token carries none.
