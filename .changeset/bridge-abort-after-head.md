---
"@statewalker/httpeers-bridge": patch
---

`createRemoteOverLink`: aborting a call's request while its response body waits for a peer that sends nothing more fails the read at once and closes the call's channel. webrun-http-streams notices an abort only when the next chunk arrives, so such a call kept its channel until the peer sent again. The request and the call's timeout are merged without `AbortSignal.any` (Safari 17.4, Firefox 124), and the outbound bound's docs say what it bounds: calls waiting for their response head.
