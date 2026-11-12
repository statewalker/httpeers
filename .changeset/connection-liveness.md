---
"@statewalker/httpeers-libp2p": minor
"@statewalker/httpeers-member": patch
---

A busy, healthy connection is no longer killed by libp2p's connection monitor. That monitor pings every connection every 10 s and, by default, aborts the whole connection when a ping takes longer than its timeout (at least 5 s); under a bulk transfer on a slow or lossy link the ping waits behind the queued data, so the connection was torn down and every exchange on it failed, on both exchange paths.

`createNode` now disables libp2p's monitor and installs `connectionLiveness()` instead: the same ping (`/ipfs/ping/1.0.0`, same interval, same adaptive timeout), but a failed ping aborts the connection only when nothing was received on it since the ping was sent. A peer that vanishes silently is still aborted within the ping interval plus the timeout (about 15 s with the defaults, as before); a connection that keeps receiving data is kept. `createNode` takes `connectionMonitor` to tune it (`pingIntervalMs`, `pingTimeout`, `abortOnPingFailure: "when-silent" | "always" | "never"`) or `false` to run no monitor. `connectionLiveness`, `CONNECTION_LIVENESS_SERVICE` and their types are exported for nodes built by hand.

`httpeers-member`'s Node and browser nodes use it too.
