---
"@statewalker/httpeers-libp2p": minor
"@statewalker/httpeers-member": patch
---

WebRTC dials are no longer retried. The retry worked around a race in libdatachannel 0.24.5 and older, where the offerer could start DTLS before the remote fingerprint was committed (`DTLS alert: unknown CA`). libdatachannel 0.24.6 fixes it, and node-datachannel bundles it from 0.33.6.

`reachHub` and the member's pre-dials (`preDialPeer`, the route ensurer) call `node.dial` directly. A WebRTC path that cannot come up now falls back to the relay circuit after one dial timeout instead of three.

`httpeers-libp2p` now depends on `node-datachannel` `^0.33.6` directly, so consumers get the floor (`@libp2p/webrtc` itself accepts `^0.33.4`). Its `./node` entry adds `warnIfOldLibdatachannel()`, which `console.warn`s once if the libdatachannel that `@libp2p/webrtc` loads is older than 0.24.6. It never throws. `versionAtLeast` and `LIBDATACHANNEL_MIN_VERSION` are exported alongside it. `httpeers-member`'s `nodePlatform` calls it when it builds a node.

BREAKING (`httpeers-libp2p`): `dialWebRTC`, `defaultWebRTCAttempts` and `WEBRTC_UPGRADE_ATTEMPTS` are removed; call `node.dial`. If your lockfile gives `@libp2p/webrtc` an older node-datachannel than your own copy, add a pnpm override (`node-datachannel: ^0.33.6`).
