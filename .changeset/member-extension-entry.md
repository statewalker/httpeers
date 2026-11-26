---
"@statewalker/httpeers-member": minor
---

Add `./extension`, the browser entry without the ServiceWorker edge: `extensionPlatform()` (a `MemberPlatform` that builds the node with `createBrowserNode`, mounts no edge, and wakes on the broker's messages through `runtimeMessageWake(chrome.runtime)`), plus `createBrowserNode`, `watchPageWake`, the IndexedDB backends and `resetBrowserState`. Nothing it reaches imports `@statewalker/webrun-http-browser`, so an offscreen-document bundle builds without it. `mountEdge` also has its own entry, `./edge`; `./browser` is unchanged.
