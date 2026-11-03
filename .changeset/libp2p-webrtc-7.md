---
"@statewalker/httpeers-member": minor
"@statewalker/httpeers-libp2p": minor
---

Takes `@libp2p/webrtc` 7 and requires `libp2p` ^3.5.1: webrtc 7's transport is typed against `@libp2p/interface-internal` 3.2, which older libp2p 3.x does not provide (the build failed with TS2322 on `registrar.use`). httpeers-member's peer range moves from `@libp2p/webrtc` ^6 to ^7.
