---
"@statewalker/httpeers-libp2p": minor
---

Move to `@statewalker/webrun-rpc` ^0.15.1, `@statewalker/webrun-streams-libp2p` ^0.7.1, `@statewalker/webrun-streams` ^0.6.1, `@statewalker/webrun-http-streams` ^0.8.1 and `@statewalker/webrun-msgpack` ^0.14.1. The mux path (the default) keeps its fixed 256 KiB window and its wire. One stream per exchange, which every serving side also serves, and the duplex protocol (`openDuplex`/`serveDuplex`) run on webrun-streams-libp2p's `connect`/`serve`, which now carry each call as a port of a windowed native-port mux (`<protocol>/ports/window`, a 4 MiB window): two peers on this version negotiate that, and against httpeers-libp2p 0.5.0 and older both ends fall back to the old protocol on `<protocol>` itself, each way (tested).

Security: 0.7.1 is required, not merely allowed (statewalker/webrun-wire#195). On 0.7.0 a caller that announced a huge port window and stopped reading made any serving side buffer a whole response. From 0.7.1 such a caller holds about one window on the server (the server's own, clamped) plus one frame, and a write blocked on the stream's drain for `drainTimeoutMs` (15 s by default) drops the exchange; a caller whose transport took the whole window before stopping leaves the exchange parked, holding about a chunk, until it reads, cancels or disconnects. `serveDuplex` takes `drainTimeoutMs` too (webrun-streams-libp2p's 5-minute default when unset).

A response ends the exchange: request bytes not yet sent are abandoned. `webrun-rpc` and `webrun-msgpack` are now loaded with webrun-streams-libp2p even by a consumer that opts out of the mux.
