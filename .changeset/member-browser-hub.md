---
"@statewalker/httpeers-member": minor
---

Add `./browser-hub` with `startBrowserHub()`: a hub assembled in a browser runtime (node, relay reservation and supervision, `createHub`, `servePeer` behind `withAccess`) with no edge, a configurable `idbStorage` name (`storageName`, or any `storage`), `mintSelfToken()`, and `serveOnLimitedConnection` for the relay-only mode of a runtime without WebRTC (documented in the README). httpeers-member now depends on `@statewalker/httpeers-hub`.
