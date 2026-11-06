# @statewalker/httpeers-bridge

## 0.2.1

### Patch Changes

- 52df011: `createRemoteOverLink`: aborting a call's request while its response body waits for a peer that sends nothing more fails the read at once and closes the call's channel. webrun-http-streams notices an abort only when the next chunk arrives, so such a call kept its channel until the peer sent again. The request and the call's timeout are merged without `AbortSignal.any` (Safari 17.4, Firefox 124), and the outbound bound's docs say what it bounds: calls waiting for their response head.
- 8d6ff11: Every call over a link gives its channel back once its exchange is over — a MessagePort pair over `pairedLinks`, a libp2p stream over libp2p. With webrun-http-streams 0.3.0 a call whose response body was read to its end left its duplex open, so every successful call kept its channel for as long as the peer lived; 0.3.1 ends the call however the exchange ends, and these packages now require it (with webrun-rpc 0.5.1, webrun-streams 0.2.3; httpeers-member's webrun-http-browser peer range is ^0.7.1).
  
  `createRemoteOverLink`: a call that times out while its response head is awaited is abandoned for the peer too — its request carries the timeout as its signal, so the peer is told and its handler let go, where before only this side stopped waiting. `pairedLinks` drops each served call once its handler is done (it kept one entry per call until the link was torn down).
  
  A response whose body is never read nor cancelled still holds its channel, as with `fetch`; read or cancel it.
- 72bff1e: A caller's `AbortSignal` reused across many calls no longer collects an abort listener per call: the signal merged for a call stops following the caller's once the response head is in. The response body is pulled only when the consumer reads it.

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-http-streams ^0.2.2 -> ^0.3.0
  - @statewalker/webrun-rpc ^0.4.0 -> ^0.5.0

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/httpeers-core@0.1.3
