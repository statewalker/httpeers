---
"@statewalker/httpeers-share": minor
---

The Bridge takes a list of allowed page origins and an optional key. `BridgeInit.allowedOrigin` is replaced by `allowedOrigins: string[]` — exact origins, `scheme://host:*` (any port) or `*` — and `originAllowed(origin, patterns)` is exported from `./bridge`. `token: ""` checks no token, on HTTP and WebSocket. `listenLoopback` is tested under Node, Bun and Deno (`pnpm test:e2e`).
