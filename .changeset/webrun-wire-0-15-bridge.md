---
"@statewalker/httpeers-bridge": minor
---

Move to `@statewalker/webrun-rpc` ^0.15.1 (was ^0.14.0). The bridge's port link runs `duplexOverPort`/`serveDuplexOverPort` from it, unchanged on the wire for a port without a window or with a fixed one; a caller that also imports webrun-rpc should take the same line, or its bundle carries two copies.
