# @statewalker/httpeers-member

## 0.3.0

### Minor Changes

- 0bdf79d: Takes `@libp2p/webrtc` 7 and requires `libp2p` ^3.5.1: webrtc 7's transport is typed against `@libp2p/interface-internal` 3.2, which older libp2p 3.x does not provide (the build failed with TS2322 on `registrar.use`). httpeers-member's peer range moves from `@libp2p/webrtc` ^6 to ^7.

### Patch Changes

- Updated dependencies [0bdf79d]
  - @statewalker/httpeers-libp2p@0.3.0

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-http-browser (peer) ^0.6.0 -> ^0.7.0
  - files changed: dist/edge-control.d.ts, dist/edge-control.d.ts.map, dist/edge-control.js, src/edge-control.ts

### Patch Changes

- Updated dependencies
  - @statewalker/httpeers-libp2p@0.2.0

## 0.1.6

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/httpeers-access@0.1.4
  - @statewalker/httpeers-core@0.1.3
  - @statewalker/httpeers-libp2p@0.1.5
