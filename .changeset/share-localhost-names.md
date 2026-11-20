---
"@statewalker/httpeers-share": minor
---

The Bridge relays to `*.localhost` names (RFC 6761), resolved first and allowed only if every address is loopback. `checkServiceTarget` treats them as local: Bridged, never Direct. `TargetVerdict`'s resolve case now carries `require: "private" | "loopback"`; `isLoopbackAddress` is exported.
