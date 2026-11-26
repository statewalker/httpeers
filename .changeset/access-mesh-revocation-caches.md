---
"@statewalker/httpeers-access": minor
---

Add `MeshRevocationCaches`, a revocation checker for a broker that verifies tokens of several meshes: one `RevocationCache` per mesh, chosen by the token's `mesh` claim, so a subject revoked in one mesh is still accepted in another.
