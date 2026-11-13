---
"@statewalker/httpeers-libp2p": patch
---

Take `@statewalker/webrun-rpc` 0.11, `@statewalker/webrun-http-streams` 0.5, `@statewalker/webrun-streams` 0.3, `@statewalker/webrun-msgpack` 0.10 and `@statewalker/webrun-streams-libp2p` 0.3.

`httpeers-libp2p` (`muxPerPeer`): the caller's presumed window ack now comes from webrun-rpc (`presumeAck: "always"`), and httpeers' own module for it (`mux-presumed-ack.ts`) is gone, with its silence check: the mux's keepalive counts only what the peer really sends, never a presumed ack, so it notices a frozen peer by itself. An exchange still takes one round trip, also against a peer on webrun-rpc 0.10 in either role. A peer whose ack contradicts the presumption no longer has its mux closed: only the exchange that relied on it fails, with `PeerStreamResetError`, and later exchanges on the same mux presume nothing and succeed. The serving side now pipelines from a port's `open` once it has read a credit on that mux, so an older caller gets a GET's head and body together from its second port on.

The per-exchange path takes webrun-streams-libp2p 0.3's bounded run-ahead: past a consumer that stopped reading, a stream pauses at 64 KiB read ahead (`readHighWaterBytes`) and yamux withholds window updates, instead of buffering up to its 16 MiB window.

A served response body that is idle when its mux dies (an SSE stream between events, a long poll) is now cancelled at once on the mux path; before, it was cancelled only at its next chunk, so a quiet stream never was. On the mux path the cancel reason, the handler's request body and its request's signal carry the session's `PeerGoneError`.
