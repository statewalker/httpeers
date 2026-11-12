# @statewalker/httpeers-member

## 0.4.0

### Minor Changes

- 9075723: The WebRTC transport's STUN/TURN servers can be chosen. Nothing changes by default: with no choice, `@libp2p/webrtc` keeps its own public STUN list.
  
  `httpeers-libp2p` exports `HTTPEERS_ICE_SERVERS` (`stun:stun.httpeers.net:3478`, the mesh's own STUN-only server, then `stun:stun.l.google.com:19302`), the `IceServer` type, `webRTCInitOf(iceServers)` (the `webRTC()` init for a choice) and `parseIceServers(text)` (a comma-separated `stun:`/`stuns:` URL list, `none` for host candidates only; TURN URLs are refused because a list cannot carry their credentials). `browserTransports()` takes `{ iceServers }`.
  
  `httpeers-member` takes `iceServers` in `createBrowserNode`, `browserPlatform`, `createSession` and `createNodeMemberNode`, and adds `nodePlatformWith({ iceServers })`. Pass `HTTPEERS_ICE_SERVERS` to opt into the mesh's STUN server once it is deployed.
- 1c11412: Experimental, off by default (#56): `muxPerPeer` on `servePeer`, `createRemote` and `serveTransport` carries every HTTP exchange with a peer as a windowed virtual port over ONE libp2p stream (`multiplexPort` from `@statewalker/webrun-rpc`, msgpack envelopes, fair framing), on its own protocol, `/httpeers/1.0.0/mux`, instead of one libp2p stream per exchange. `true` takes the defaults (`DEFAULT_MUX_WINDOW`, 256 KiB; `DEFAULT_MUX_FRAME_SIZE`, 31 KiB), or pass `{ window, frameSize, maxMessageBytes, maxReassembledBytes, maxPorts, keepaliveMs, fallback, protocol }`.
  
  - A stalled reader holds only its own port's window, and a dead stream fails every exchange open on it at once with `PeerStreamResetError`; the next call opens a new mux.
  - The serving side keeps the per-exchange path's bounds: at most `maxInboundStreams` exchanges at once per connection across its muxes (a refused port surfaces as `PeerStreamResetError`), an exchange whose response write stays blocked on the caller for `drainTimeoutMs` dropped, which the caller sees as `PeerStreamResetError` (a quiet one is not dropped), messages on the stream bounded by the frame size, reassembly capped at one window, and a keepalive.
  - A peer with the flag serves both protocols; a caller with it falls back to a stream per exchange for a peer without the mux protocol (or, with `fallback: false`, fails with `PeerProtocolUnsupportedError`), and when every mux stream on the connection is taken.
  - Only the option selects it: nothing reads the environment. `startMember` (`@statewalker/httpeers-member`) takes `muxPerPeer` and forwards it.
  - Frames posted in the same task leave the mux stream as one write (up to one Noise message), its read buffer stays within a few frames (`messageTargetOverStream` from webrun-streams-libp2p 0.2 grows its buffer with all the traffic a stream has carried, so the mux path frames its stream itself, in the same wire format), and the stall watch keeps one timer per exchange rather than one per piece. On loopback (`scripts/bench-mux.mjs`) one bulk exchange streams about 55% of the per-exchange path's rate at the default window and about 90% at 4 MiB, small exchanges match it, and 256 B messages on long-lived exchanges run at 60–97% of it.
  - webrun-rpc and webrun-msgpack are loaded with a dynamic `import()` the first time a mux link is used, so the root entry does not load them otherwise.
  
  New exports: `MUX_PROTOCOL`, `muxProtocolOf`, `DEFAULT_MUX_WINDOW`, `DEFAULT_MUX_FRAME_SIZE`, `DEFAULT_MUX_KEEPALIVE_MS`, `MUX_MESSAGE_HEADROOM`, `MUX_MAX_STREAMS_PER_CONNECTION`, `MuxPortClosedError`, and the `MuxPerPeer` / `MuxPerPeerOptions` types. `servePeer`'s `stop()` now also closes the muxes its calls opened (a no-op without the flag). Nothing changes without the flag.
  
  `@statewalker/httpeers-bridge` takes `@statewalker/webrun-rpc` ^0.10.2 (was ^0.5.1). The MessagePort link (`pairedLinks`) uses plain ports, without a window, which behave as before.

### Patch Changes

- 157fa32: A busy, healthy connection is no longer killed by libp2p's connection monitor. That monitor pings every connection every 10 s and, by default, aborts the whole connection when a ping takes longer than its timeout (at least 5 s); under a bulk transfer on a slow or lossy link the ping waits behind the queued data, so the connection was torn down and every exchange on it failed, on both exchange paths.
  
  `createNode` now disables libp2p's monitor and installs `connectionLiveness()` instead: the same ping (`/ipfs/ping/1.0.0`, same interval, same adaptive timeout), but a failed ping aborts the connection only when nothing was received on it since the ping was sent. A connection that keeps receiving data is kept. Each connection has its own ping timeout, learned only from answered pings, so one slow or failing connection never lengthens another's.
  
  A peer that vanishes silently is still aborted within the ping interval plus that connection's ping timeout: about 15 s with the defaults, as before (measured 13.0 s). While the node is receiving at least 64 KiB on other connections during the failed ping, that is read as a congested shared link and the connection is aborted at its second silent failure in a row instead, within two intervals plus the timeout (about 25 s; measured 23.0 s). Both bounds assume the connection's learned timeout is no longer than the interval; on a slow link where it has grown past the interval, the worst case approaches two intervals plus twice the timeout. That gives an idle connection on a congested link (a relay reservation beside a download) one more interval, not immunity: a queue that delays its pings past two intervals still loses it.
  
  Received bytes are seen from the transport's raw connection on TCP, WebSockets and relayed circuits, and from `RTCPeerConnection.getStats()` on WebRTC; a connection that offers neither is aborted on any failed ping, as libp2p does. `createNode` takes `connectionMonitor` to tune it (`pingIntervalMs`, `pingTimeout`, `abortOnPingFailure: "when-silent" | "always" | "never"`, `silentFailuresWhenBusy`) or `false` to run no monitor. `connectionLiveness`, `CONNECTION_LIVENESS_SERVICE` and their types are exported for nodes built by hand. The `libp2p_connection_monitor_ping_time_milliseconds` metric is still recorded when metrics are configured.
  
  `httpeers-member`'s Node and browser nodes use it too.
- 2e3e21f: WebRTC dials are no longer retried. The retry worked around a race in libdatachannel 0.24.5 and older, where the offerer could start DTLS before the remote fingerprint was committed (`DTLS alert: unknown CA`). libdatachannel 0.24.6 fixes it, and node-datachannel bundles it from 0.33.6.
  
  `reachHub` and the member's pre-dials (`preDialPeer`, the route ensurer) call `node.dial` directly. A WebRTC path that cannot come up now falls back to the relay circuit after one dial timeout instead of three.
  
  `httpeers-libp2p` now depends on `node-datachannel` `^0.33.6` directly, so consumers get the floor (`@libp2p/webrtc` itself accepts `^0.33.4`). Its `./node` entry adds `warnIfOldLibdatachannel()`, which `console.warn`s once if the libdatachannel that `@libp2p/webrtc` loads is older than 0.24.6. It never throws. `versionAtLeast` and `LIBDATACHANNEL_MIN_VERSION` are exported alongside it. `httpeers-member`'s `nodePlatform` calls it when it builds a node.
  
  BREAKING (`httpeers-libp2p`): `dialWebRTC`, `defaultWebRTCAttempts` and `WEBRTC_UPGRADE_ATTEMPTS` are removed; call `node.dial`. If your lockfile gives `@libp2p/webrtc` an older node-datachannel than your own copy, add a pnpm override (`node-datachannel: ^0.33.6`).
- Updated dependencies [9075723]
- Updated dependencies [157fa32]
- Updated dependencies [49c741d]
- Updated dependencies [6f9da2c]
- Updated dependencies [1c11412]
- Updated dependencies [b7b63de]
- Updated dependencies [2e3e21f]
- Updated dependencies [9e1af46]
  - @statewalker/httpeers-libp2p@0.4.0
  - @statewalker/httpeers-core@0.1.4

## 0.3.2

### Patch Changes

- 8bb4121: `dialWebRTC` makes one attempt by default in a browser (`defaultWebRTCAttempts()`), and keeps three under Node. The retry works around a node-datachannel race that browsers don't have. In a browser it only tripled the wait before a member fell back to the relay circuit when WebRTC could not connect: a Guest's join took 18 s instead of 6 s, measured in Chromium with UDP blocked.
- Updated dependencies [8bb4121]
  - @statewalker/httpeers-libp2p@0.3.2

## 0.3.1

### Patch Changes

- 8d6ff11: Every call over a link gives its channel back once its exchange is over — a MessagePort pair over `pairedLinks`, a libp2p stream over libp2p. With webrun-http-streams 0.3.0 a call whose response body was read to its end left its duplex open, so every successful call kept its channel for as long as the peer lived; 0.3.1 ends the call however the exchange ends, and these packages now require it (with webrun-rpc 0.5.1, webrun-streams 0.2.3; httpeers-member's webrun-http-browser peer range is ^0.7.1).
  
  `createRemoteOverLink`: a call that times out while its response head is awaited is abandoned for the peer too — its request carries the timeout as its signal, so the peer is told and its handler let go, where before only this side stopped waiting. `pairedLinks` drops each served call once its handler is done (it kept one entry per call until the link was torn down).
  
  A response whose body is never read nor cancelled still holds its channel, as with `fetch`; read or cancel it.
- Updated dependencies [8d6ff11]
  - @statewalker/httpeers-libp2p@0.3.1

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
