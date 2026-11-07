# @statewalker/httpeers-share

## 0.3.0

### Minor Changes

- beb120e: The Bridge takes a list of allowed page origins and an optional key. `BridgeInit.allowedOrigin` is replaced by `allowedOrigins: string[]` — exact origins, `scheme://host:*` (any port) or `*` — and `originAllowed(origin, patterns)` is exported from `./bridge`. `token: ""` checks no token, on HTTP and WebSocket (a WebSocket still offers a `peershare.` subprotocol). Requests whose `Host` is not a loopback name are refused (DNS rebinding). `listenLoopback` is tested under Node, Bun and Deno (`pnpm test:e2e`).

## 0.2.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-member ^0.3.0 -> ^0.3.1

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-member crosses a breaking line

### Patch Changes

- Updated dependencies [0bdf79d]
  - @statewalker/httpeers-member@0.3.0

## 0.1.0

### Minor Changes

- 73d61a5: New package: share HTTP services with the members of a mesh. Upstream kinds (direct, bridged through a loopback Bridge), the sharing policy, the probe, the service table with a live catalog and pause, invite links with the join blob in the fragment, join outcomes, Guest stamping, WebSockets carried inside one full-duplex mesh request, and the Bridge itself (`./bridge`, Node and Bun) with per-Guest cookie jars.

### Patch Changes

- Updated dependencies
  - @statewalker/httpeers-member@0.2.0
