---
"@statewalker/httpeers-libp2p": patch
---

The experimental mux path (`muxPerPeer`, #56) answers an exchange in one round trip instead of two, and no longer runs concurrent exchanges in lock-step rounds.

- One round trip: the caller takes each port's window agreement as given when it opens the port, so it answers the window handshake right behind its `open` and pipelines its own request at once. The serving side then pipelines its response from the start: head and body arrive together after one round trip, for a GET and for a POST whose handler reads the body. Nothing new goes on the wire (the answer is the same envelope, sent earlier), so callers and serving peers of either version interoperate. The presumption is what every serving build of `/httpeers/1.0.0/mux` acks; if a peer's real ack says otherwise, or the peer goes silent while ports keep opening, the caller closes the mux (`PeerStreamResetError`, and the next call opens a new one).
- No lock-step: frames gathered into one write wait at most 1 ms within a task, so a burst of exchanges served in one task no longer leaves as one write after the last of them.

On an emulated 100 Mbit/s, 100 ms link, a ping takes 104 ms instead of 207 ms, and 100 concurrent 256 B exchanges run at about 690/s instead of 305/s (the per-exchange path: 440/s).
