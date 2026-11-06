---
"@statewalker/httpeers-bridge": patch
"@statewalker/httpeers-libp2p": patch
"@statewalker/httpeers-member": patch
---

Every call over a link gives its channel back once its exchange is over — a MessagePort pair over `pairedLinks`, a libp2p stream over libp2p. With webrun-http-streams 0.3.0 a call whose response body was read to its end left its duplex open, so every successful call kept its channel for as long as the peer lived; 0.3.1 ends the call however the exchange ends, and these packages now require it (with webrun-rpc 0.5.1, webrun-streams 0.2.3; httpeers-member's webrun-http-browser peer range is ^0.7.1).

`createRemoteOverLink`: a call that times out while its response head is awaited is abandoned for the peer too — its request carries the timeout as its signal, so the peer is told and its handler let go, where before only this side stopped waiting. `pairedLinks` drops each served call once its handler is done (it kept one entry per call until the link was torn down).

A response whose body is never read nor cancelled still holds its channel, as with `fetch`; read or cancel it.
