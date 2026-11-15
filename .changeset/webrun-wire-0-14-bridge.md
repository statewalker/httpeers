---
"@statewalker/httpeers-bridge": minor
---

Move to webrun-wire's current lines: `@statewalker/webrun-rpc` ^0.14.0 (was ^0.11.0), `@statewalker/webrun-streams` ^0.6.0 (was ^0.3.0) and `@statewalker/webrun-http-streams` ^0.8.0 (was ^0.5.0). The bridge's types name `Duplex` and `MessageTarget` from these packages, so a caller that hands it one should take them from the same lines. A 400 or 500 the bridge's codec produces no longer carries the server's stack in its `x-webrun-error` header (webrun-http-streams 0.6).
