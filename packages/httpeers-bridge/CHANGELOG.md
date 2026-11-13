# @statewalker/httpeers-bridge

## 0.3.1

### Patch Changes

- 3dc6be0: Depends on `@statewalker/webrun-http-streams` ^0.5.0, `@statewalker/webrun-rpc` ^0.11.0 and `@statewalker/webrun-streams` ^0.3.0.

## 0.3.0

### Minor Changes

- 1c11412: Experimental, off by default (#56): `muxPerPeer` on `servePeer`, `createRemote` and `serveTransport` carries every HTTP exchange with a peer as a windowed virtual port over ONE libp2p stream (`multiplexPort` from `@statewalker/webrun-rpc`, msgpack envelopes, fair framing), on its own protocol, `/httpeers/1.0.0/mux`, instead of one libp2p stream per exchange. `true` takes the defaults (`DEFAULT_MUX_WINDOW`, 256 KiB; `DEFAULT_MUX_FRAME_SIZE`, 31 KiB), or pass `{ window, frameSize, maxMessageBytes, maxReassembledBytes, maxPorts, keepaliveMs, fallback, protocol }`.
  
  - A stalled reader holds only its own port's window, and a dead stream fails every exchange open on it at once with `PeerStreamResetError`; the next call opens a new mux.
  - The serving side keeps the per-exchange path's bounds: at most `maxInboundStreams` exchanges at once per connection across its muxes (a refused port surfaces as `PeerStreamResetError`), an exchange whose response write stays blocked on the caller for `drainTimeoutMs` dropped, which the caller sees as `PeerStreamResetError` (a quiet one is not dropped), messages on the stream bounded by the frame size, reassembly capped at one window, and a keepalive.
  - A peer with the flag serves both protocols; a caller with it falls back to a stream per exchange for a peer without the mux protocol (or, with `fallback: false`, fails with `PeerProtocolUnsupportedError`), and when every mux stream on the connection is taken.
  - Only the option selects it: nothing reads the environment. `startMember` (`@statewalker/httpeers-member`) takes `muxPerPeer` and forwards it.
  - Frames posted in the same task leave the mux stream as one write (up to one Noise message), its read buffer stays within a few frames (`messageTargetOverStream` from webrun-streams-libp2p 0.2 grows its buffer with all the traffic a stream has carried, so the mux path frames its stream itself, in the same wire format), and the stall watch keeps one timer per exchange rather than one per piece. On loopback (`scripts/bench-mux.mjs`) one bulk exchange streams about 55% of the per-exchange path's rate at the default window and about 90% at 4 MiB, small exchanges match it, and 256 B messages on long-lived exchanges run at 60–97% of it.
  - webrun-rpc and webrun-msgpack are loaded with a dynamic `import()` the first time a mux link is used, so the root entry does not load them otherwise.
  
  New exports: `MUX_PROTOCOL`, `muxProtocolOf`, `DEFAULT_MUX_WINDOW`, `DEFAULT_MUX_FRAME_SIZE`, `DEFAULT_MUX_KEEPALIVE_MS`, `MUX_MESSAGE_HEADROOM`, `MUX_MAX_STREAMS_PER_CONNECTION`, `MuxPortClosedError`, and the `MuxPerPeer` / `MuxPerPeerOptions` types. `servePeer`'s `stop()` now also closes the muxes its calls opened (a no-op without the flag). Nothing changes without the flag.
  
  `@statewalker/httpeers-bridge` takes `@statewalker/webrun-rpc` ^0.10.2 (was ^0.5.1). The MessagePort link (`pairedLinks`) uses plain ports, without a window, which behave as before.
- 9e1af46: Takes `@statewalker/webrun-streams-libp2p` 0.2, which ends a call whose stream stopped before the call finished (a dead connection, a reset mid-read, a peer that died after ending its side) with `PeerGoneError` instead of a clean end. `mapPeerCallError` maps it to `PeerStreamResetError`, keeping it as `cause`.
  
  `createRemoteOverLink` takes a new option, `mapBodyError`, for errors that end a response body after its head is in. It maps nothing by default, and `mapError` still sees pre-head failures only. `httpeers-libp2p`'s `createRemote` passes one that maps `PeerGoneError` and nothing else, so a peer that dies mid-body fails the read with `PeerStreamResetError`, while an error the serving peer's own body raises (an app error, a handler's `TimeoutError`) still reaches the reader as the peer sent it.
  
  The `DEFAULT_MAX_CONCURRENT_OUTBOUND` docs (and the bridge README) now say what the permit bounds: calls waiting for a response head, not open streams.

### Patch Changes

- Updated dependencies [9e1af46]
  - @statewalker/httpeers-core@0.1.4

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
