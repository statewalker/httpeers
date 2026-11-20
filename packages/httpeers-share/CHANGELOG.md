# @statewalker/httpeers-share

## 0.8.0

### Minor Changes

- 4bb75d6: The Bridge relays to `*.localhost` names (RFC 6761), resolved first and allowed only if every address is loopback. `checkServiceTarget` treats them as local: Bridged, never Direct. `TargetVerdict`'s resolve case now carries `require: "private" | "loopback"`; `isLoopbackAddress` is exported.

## 0.7.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-member crosses a breaking line

### Patch Changes

- Updated dependencies
  - @statewalker/httpeers-member@0.7.0

## 0.6.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-member crosses a breaking line

### Patch Changes

- Updated dependencies
- Updated dependencies [8668d22]
- Updated dependencies [bd70fa2]
  - @statewalker/httpeers-member@0.6.0

## 0.5.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-member crosses a breaking line

### Patch Changes

- Updated dependencies
- Updated dependencies [ec6a281]
  - @statewalker/httpeers-member@0.5.0

## 0.4.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-hub ^0.1.5 -> ^0.1.6

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-member crosses a breaking line

### Patch Changes

- Updated dependencies [9075723]
- Updated dependencies [157fa32]
- Updated dependencies [1c11412]
- Updated dependencies [2e3e21f]
- Updated dependencies [9e1af46]
  - @statewalker/httpeers-member@0.4.0
  - @statewalker/httpeers-core@0.1.4

## 0.3.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-member ^0.3.1 -> ^0.3.2

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
