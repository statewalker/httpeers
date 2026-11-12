# @statewalker/httpeers-core

## 0.1.4

### Patch Changes

- 9e1af46: Takes `@statewalker/webrun-streams-libp2p` 0.2, which ends a call whose stream stopped before the call finished (a dead connection, a reset mid-read, a peer that died after ending its side) with `PeerGoneError` instead of a clean end. `mapPeerCallError` maps it to `PeerStreamResetError`, keeping it as `cause`.
  
  `createRemoteOverLink` takes a new option, `mapBodyError`, for errors that end a response body after its head is in. It maps nothing by default, and `mapError` still sees pre-head failures only. `httpeers-libp2p`'s `createRemote` passes one that maps `PeerGoneError` and nothing else, so a peer that dies mid-body fails the read with `PeerStreamResetError`, while an error the serving peer's own body raises (an app error, a handler's `TimeoutError`) still reaches the reader as the peer sent it.
  
  The `DEFAULT_MAX_CONCURRENT_OUTBOUND` docs (and the bridge README) now say what the permit bounds: calls waiting for a response head, not open streams.

## 0.1.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
