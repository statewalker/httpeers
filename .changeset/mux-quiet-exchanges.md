---
"@statewalker/httpeers-libp2p": patch
---

`muxPerPeer` (experimental, #56): the serving side no longer drops a quiet exchange. It used to serve each port with an idle timeout of `drainTimeoutMs` (15 s) that counted any silence, so an event stream that waited between events, a slow response head or an idle tunnel failed with `PeerStreamResetError` after 15 s. Now, as on the per-exchange path, `drainTimeoutMs` bounds only a response write left blocked on the caller (no window credit): such an exchange's handler is cancelled, its port closed and no longer counted against `maxInboundStreams`, and the caller gets `PeerStreamResetError`. Silence is never a reason to drop an exchange.
