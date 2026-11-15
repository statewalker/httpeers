---
"@statewalker/httpeers-libp2p": minor
---

Move to webrun-wire's current lines: `@statewalker/webrun-rpc` ^0.14.0 (was ^0.11.0), `@statewalker/webrun-streams` ^0.6.0 (was ^0.3.0), `@statewalker/webrun-streams-libp2p` ^0.6.0 (was ^0.3.0), `@statewalker/webrun-http-streams` ^0.8.0 (was ^0.5.0) and `@statewalker/webrun-msgpack` ^0.13.0 (was ^0.10.0). The wire is unchanged: a peer on this version and one on httpeers-libp2p 0.5.0 (webrun-rpc 0.11) read each other on the mux path, each way, a GET and a POST in one round trip, as do callers and serving sides on webrun-rpc 0.10. A 400 or 500 a serving side's codec produces no longer carries the server's stack in its `x-webrun-error` header (webrun-http-streams 0.6). A bundle that also imports these packages should move to the same lines, or it carries two copies of each.
