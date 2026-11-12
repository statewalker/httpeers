---
"@statewalker/httpeers-libp2p": patch
---

Mux per peer (#56): a mux that closes itself (its keepalive finding the peer silent while the stream still looks alive, a failing pump, a stream the peer ended or sent a malformed frame on) now dies the way a dead stream does. Exchanges open on it fail with `PeerStreamResetError` (cause `PeerGoneError`) instead of `UnknownPeerCallError`, and the dead session is dropped, so the next call dials a new mux; before, every later call to that peer failed with "the multiplexer is closed". On the serving side a handler reading its request body sees `PeerGoneError`, and the session no longer lingers in the link's tables.
