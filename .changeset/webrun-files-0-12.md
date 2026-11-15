---
"@statewalker/httpeers-hub": patch
---

Accept `@statewalker/webrun-files` 0.12 as a peer (`^0.9.0 || ^0.10.0 || ^0.12.0`). The hub only takes a `FilesApi` from it as a type, so the 0.12 path changes (`..` resolved before any filter, guard or mount; `Path climbs above the root` above the root) do not affect it.
