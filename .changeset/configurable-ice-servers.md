---
"@statewalker/httpeers-libp2p": minor
"@statewalker/httpeers-member": minor
---

The WebRTC transport's STUN/TURN servers can be chosen. Nothing changes by default: with no choice, `@libp2p/webrtc` keeps its own public STUN list.

`httpeers-libp2p` exports `HTTPEERS_ICE_SERVERS` (`stun:stun.httpeers.net:3478`, the mesh's own STUN-only server, then `stun:stun.l.google.com:19302`), the `IceServer` type, `webRTCInitOf(iceServers)` (the `webRTC()` init for a choice) and `parseIceServers(text)` (a comma-separated `stun:`/`stuns:` URL list, `none` for host candidates only; TURN URLs are refused because a list cannot carry their credentials). `browserTransports()` takes `{ iceServers }`.

`httpeers-member` takes `iceServers` in `createBrowserNode`, `browserPlatform`, `createSession` and `createNodeMemberNode`, and adds `nodePlatformWith({ iceServers })`. Pass `HTTPEERS_ICE_SERVERS` to opt into the mesh's STUN server once it is deployed.
