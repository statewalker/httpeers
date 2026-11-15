---
"@statewalker/httpeers-member": patch
---

`startMember` now carries a member's exchanges over one windowed mux per peer when `muxPerPeer` is unset, following `@statewalker/httpeers-libp2p`'s new default (httpeers#56). Pass `muxPerPeer: false` to keep one libp2p stream per exchange. Members on either path interoperate with hubs and peers on the other.
