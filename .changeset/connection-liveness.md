---
"@statewalker/httpeers-libp2p": minor
"@statewalker/httpeers-member": patch
---

A busy, healthy connection is no longer killed by libp2p's connection monitor. That monitor pings every connection every 10 s and, by default, aborts the whole connection when a ping takes longer than its timeout (at least 5 s); under a bulk transfer on a slow or lossy link the ping waits behind the queued data, so the connection was torn down and every exchange on it failed, on both exchange paths.

`createNode` now disables libp2p's monitor and installs `connectionLiveness()` instead: the same ping (`/ipfs/ping/1.0.0`, same interval, same adaptive timeout), but a failed ping aborts the connection only when nothing was received on it since the ping was sent. A connection that keeps receiving data is kept. Each connection has its own ping timeout, learned only from answered pings, so one slow or failing connection never lengthens another's.

A peer that vanishes silently is still aborted within the ping interval plus that connection's ping timeout: about 15 s with the defaults, as before (measured 13.0 s). While the node is receiving at least 64 KiB on other connections during the failed ping, that is read as a congested shared link and the connection is aborted at its second silent failure in a row instead, within two intervals plus the timeout (about 25 s; measured 23.0 s). Both bounds assume the connection's learned timeout is no longer than the interval; on a slow link where it has grown past the interval, the worst case approaches two intervals plus twice the timeout. That gives an idle connection on a congested link (a relay reservation beside a download) one more interval, not immunity: a queue that delays its pings past two intervals still loses it.

Received bytes are seen from the transport's raw connection on TCP, WebSockets and relayed circuits, and from `RTCPeerConnection.getStats()` on WebRTC; a connection that offers neither is aborted on any failed ping, as libp2p does. `createNode` takes `connectionMonitor` to tune it (`pingIntervalMs`, `pingTimeout`, `abortOnPingFailure: "when-silent" | "always" | "never"`, `silentFailuresWhenBusy`) or `false` to run no monitor. `connectionLiveness`, `CONNECTION_LIVENESS_SERVICE` and their types are exported for nodes built by hand. The `libp2p_connection_monitor_ping_time_milliseconds` metric is still recorded when metrics are configured.

`httpeers-member`'s Node and browser nodes use it too.
