# @statewalker/httpeers-hub

## 0.2.0

### Minor Changes

- 4babbc5: `createHub` takes `storageKey`, the key its state is saved under (default `"snapshot"`, unchanged), so several hubs can share one storage without overwriting each other's snapshot.

### Patch Changes

- Updated dependencies [ad4e554]
- Updated dependencies [31d6746]
- Updated dependencies [e3b74ee]
- Updated dependencies [ab7b167]
  - @statewalker/httpeers-access@0.2.0

## 0.1.6

### Patch Changes

- f33663f: Accept `@statewalker/webrun-files` 0.12 as a peer (`^0.9.0 || ^0.10.0 || ^0.12.0`). The hub only takes a `FilesApi` from it as a type, so the 0.12 path changes (`..` resolved before any filter, guard or mount; `Path climbs above the root` above the root) do not affect it.

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/httpeers-core ^0.1.3 -> ^0.1.4
- Updated dependencies
  - @statewalker/httpeers-access@0.1.5

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
  - @statewalker/httpeers-access@0.1.4
  - @statewalker/httpeers-core@0.1.3
