---
"@statewalker/httpeers-libp2p": patch
"@statewalker/httpeers-member": patch
---

`dialWebRTC` makes one attempt by default in a browser (`defaultWebRTCAttempts()`), and keeps three under Node. The retry works around a node-datachannel race that browsers don't have. In a browser it only tripled the wait before a member fell back to the relay circuit when WebRTC could not connect: a Guest's join took 18 s instead of 6 s, measured in Chromium with UDP blocked.
