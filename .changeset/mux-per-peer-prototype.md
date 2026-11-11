---
"@statewalker/httpeers-libp2p": minor
"@statewalker/httpeers-bridge": minor
"@statewalker/httpeers-member": minor
---

Experimental, off by default (#56): `muxPerPeer` on `servePeer`, `createRemote` and `serveTransport` carries every HTTP exchange with a peer as a windowed virtual port over ONE libp2p stream (`multiplexPort` from `@statewalker/webrun-rpc`, msgpack envelopes, fair framing), on its own protocol, `/httpeers/1.0.0/mux`, instead of one libp2p stream per exchange. `true` takes the defaults (`DEFAULT_MUX_WINDOW`, 256 KiB; `DEFAULT_MUX_FRAME_SIZE`, 31 KiB), or pass `{ window, frameSize, maxMessageBytes, maxReassembledBytes, maxPorts, keepaliveMs, fallback, protocol }`.

- A stalled reader holds only its own port's window, and a dead stream fails every exchange open on it at once with `PeerStreamResetError`; the next call opens a new mux.
- The serving side keeps the per-exchange path's bounds: at most `maxInboundStreams` exchanges at once per connection across its muxes (a refused port surfaces as `PeerStreamResetError`), an exchange whose response write stays blocked on the caller for `drainTimeoutMs` dropped (a quiet one is not), messages on the stream bounded by the frame size, reassembly capped at one window, and a keepalive.
- A peer with the flag serves both protocols; a caller with it falls back to a stream per exchange for a peer without the mux protocol (or, with `fallback: false`, fails with `PeerProtocolUnsupportedError`), and when every mux stream on the connection is taken.
- Only the option selects it: nothing reads the environment. `startMember` (`@statewalker/httpeers-member`) takes `muxPerPeer` and forwards it.
- Frames posted in the same task leave the mux stream as one write (up to one Noise message), its read buffer stays within a few frames (`messageTargetOverStream` from webrun-streams-libp2p 0.2 grows its buffer with all the traffic a stream has carried, so the mux path frames its stream itself, in the same wire format), and the stall watch keeps one timer per exchange rather than one per piece. On loopback (`scripts/bench-mux.mjs`) one bulk exchange streams about 55% of the per-exchange path's rate at the default window and about 90% at 4 MiB, small exchanges match it, and 256 B messages on long-lived exchanges run at 60–97% of it.
- webrun-rpc and webrun-msgpack are loaded with a dynamic `import()` the first time a mux link is used, so the root entry does not load them otherwise.

New exports: `MUX_PROTOCOL`, `muxProtocolOf`, `DEFAULT_MUX_WINDOW`, `DEFAULT_MUX_FRAME_SIZE`, `DEFAULT_MUX_KEEPALIVE_MS`, `MUX_MESSAGE_HEADROOM`, `MUX_MAX_STREAMS_PER_CONNECTION`, `MuxPortClosedError`, and the `MuxPerPeer` / `MuxPerPeerOptions` types. `servePeer`'s `stop()` now also closes the muxes its calls opened (a no-op without the flag). Nothing changes without the flag.

`@statewalker/httpeers-bridge` takes `@statewalker/webrun-rpc` ^0.10.2 (was ^0.5.1). The MessagePort link (`pairedLinks`) uses plain ports, without a window, which behave as before.
