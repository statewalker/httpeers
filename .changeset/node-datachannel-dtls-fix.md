---
"@statewalker/httpeers-libp2p": minor
"@statewalker/httpeers-member": patch
---

WebRTC dials are no longer retried. It worked around a race in libdatachannel 0.24.5 and older, where the offerer could start DTLS before the remote fingerprint was committed (`DTLS alert: unknown CA`). libdatachannel 0.24.6 fixes it, and node-datachannel bundles it from 0.33.6. The workspace now requires node-datachannel `^0.33.6` (a pnpm override), and a test checks the loaded libdatachannel version.

`reachHub` and the member's pre-dials (`preDialPeer`, the route ensurer) call `node.dial` directly. A WebRTC path that cannot come up now falls back to the relay circuit after one dial timeout instead of three.

BREAKING (`httpeers-libp2p`): `dialWebRTC`, `defaultWebRTCAttempts` and `WEBRTC_UPGRADE_ATTEMPTS` are removed; call `node.dial`. Under Node, use node-datachannel 0.33.6 or newer: `@libp2p/webrtc` accepts `^0.33.4`, so a lockfile may still hold a release without the fix. Add a pnpm override if it does.
