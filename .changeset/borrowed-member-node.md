---
"@statewalker/httpeers-member": minor
---

`startMember` takes `node`, a libp2p node the caller owns, and never stops it (a failed start used to stop a node it was given, taking another membership's links down), and `protocol`, forwarded to `servePeer` so one node can serve a second mesh on a protocol of its own. The README states the rule: one libp2p node per mesh.
