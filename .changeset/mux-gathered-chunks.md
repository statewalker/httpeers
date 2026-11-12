---
"@statewalker/httpeers-libp2p": patch
---

The experimental mux path (`muxPerPeer`, #56) no longer falls behind the per-exchange path on lossy links with many concurrent small exchanges.

- The pieces the HTTP codec writes back to back (a message's head, each body chunk's size line, data and CRLF, the last-chunk marker) now go as one mux message per direction instead of one each, so a 256 B exchange carries about 0.8 KB on the wire each way instead of about 1.2 KB, where the per-exchange path carries about 0.85 KB. Only chunk boundaries move, so peers of any version interoperate. Nothing waits for data that is not already being produced, and tearing an exchange down still reaches its producer at once.
- Frames gathered into one write now stop at 16 KiB instead of a whole Noise message (64 KB), which the far side can read only once all of it has arrived: on a lossy link such a batch took several round trips to arrive and delivered every exchange in it at once.

On an emulated 10 Mbit/s, 80 ms link with 1% loss, 100 concurrent 256 B exchanges run at about 240/s instead of 110/s (the per-exchange path: about 150/s); with 2 Mbit/s, 200 ms and 3% loss at about 40/s instead of 25/s (per-exchange: 38/s). On the links without loss the same case runs 1.2–1.8 times faster than before.
