---
"@statewalker/httpeers-libp2p": minor
---

One windowed mux per peer is now the default exchange path (#56). `servePeer`, `createRemote` and `serveTransport` carry every exchange with a peer as a port of one libp2p stream (`/httpeers/1.0.0/mux`) unless `muxPerPeer: false` is passed, which keeps one libp2p stream per exchange as before. Peers interoperate across the change: a mux peer still serves the per-exchange protocol, and a mux caller falls back to a stream per exchange for a peer that does not speak the mux. Measured on a real link, small exchanges run 1.5–2.3x as fast and a request beside a bulk download no longer queues behind it; bulk on high bandwidth-delay links is capped by the 256 KiB default window (raise `window`, or opt out).
