---
"@statewalker/httpeers-libp2p": minor
"@statewalker/httpeers-bridge": patch
"@statewalker/httpeers-core": patch
---

Takes `@statewalker/webrun-streams-libp2p` 0.2, which ends a call whose stream stopped before the call finished (a dead connection, a reset mid-read, a peer that died after ending its side) with `PeerGoneError` instead of a clean end. `mapPeerCallError` maps it to `PeerStreamResetError`, keeping it as `cause`. The bridge now runs an error that ends a response body through `mapError` too, so a peer that dies mid-body fails the read with that typed error rather than the raw transport one. The `DEFAULT_MAX_CONCURRENT_OUTBOUND` docs now say what it bounds: calls waiting for a response head, not open streams.
