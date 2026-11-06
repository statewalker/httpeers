---
"@statewalker/httpeers-bridge": patch
---

Every call over a link gives its channel back once its exchange is over — a MessagePort pair over `pairedLinks`, a libp2p stream over libp2p. With webrun-http-streams 0.3.0 a call whose response body was read to its end left its duplex open, so every successful call kept its channel for as long as the peer lived; 0.3.1 ends the call however the exchange ends, and the bridge now requires it. `pairedLinks` also drops each served call once its handler is done (it kept one entry per call until the link was torn down).
