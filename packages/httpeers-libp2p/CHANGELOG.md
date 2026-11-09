# @statewalker/httpeers-libp2p

## 0.3.2

### Patch Changes

- 8bb4121: `dialWebRTC` makes one attempt by default in a browser (`defaultWebRTCAttempts()`), and keeps three under Node. The retry works around a node-datachannel race that browsers don't have. In a browser it only tripled the wait before a member fell back to the relay circuit when WebRTC could not connect: a Guest's join took 18 s instead of 6 s, measured in Chromium with UDP blocked.

## 0.3.1

### Patch Changes

- 8d6ff11: Every call over a link gives its channel back once its exchange is over — a MessagePort pair over `pairedLinks`, a libp2p stream over libp2p. With webrun-http-streams 0.3.0 a call whose response body was read to its end left its duplex open, so every successful call kept its channel for as long as the peer lived; 0.3.1 ends the call however the exchange ends, and these packages now require it (with webrun-rpc 0.5.1, webrun-streams 0.2.3; httpeers-member's webrun-http-browser peer range is ^0.7.1).
  
  `createRemoteOverLink`: a call that times out while its response head is awaited is abandoned for the peer too — its request carries the timeout as its signal, so the peer is told and its handler let go, where before only this side stopped waiting. `pairedLinks` drops each served call once its handler is done (it kept one entry per call until the link was torn down).
  
  A response whose body is never read nor cancelled still holds its channel, as with `fetch`; read or cancel it.
- Updated dependencies [52df011]
- Updated dependencies [8d6ff11]
- Updated dependencies [72bff1e]
  - @statewalker/httpeers-bridge@0.2.1

## 0.3.0

### Minor Changes

- 0bdf79d: Takes `@libp2p/webrtc` 7 and requires `libp2p` ^3.5.1: webrtc 7's transport is typed against `@libp2p/interface-internal` 3.2, which older libp2p 3.x does not provide (the build failed with TS2322 on `registrar.use`). httpeers-member's peer range moves from `@libp2p/webrtc` ^6 to ^7.

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-http-streams ^0.2.2 -> ^0.3.0

### Patch Changes

- Updated dependencies
  - @statewalker/httpeers-bridge@0.2.0

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
  - @statewalker/httpeers-bridge@0.1.4
  - @statewalker/httpeers-core@0.1.3
