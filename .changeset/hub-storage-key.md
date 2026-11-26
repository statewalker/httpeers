---
"@statewalker/httpeers-hub": minor
---

`createHub` takes `storageKey`, the key its state is saved under (default `"snapshot"`, unchanged), so several hubs can share one storage without overwriting each other's snapshot.
