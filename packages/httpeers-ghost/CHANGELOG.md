# @statewalker/httpeers-ghost

## 0.1.5

### Patch Changes

- fd5e435: `contain` in `sandbox` mode keeps a non-HTML response's status and status text. It used to rebuild the response with `{ ...response, headers }`, which copies neither (they are prototype getters), so a 404 or 304 asset reached the frame as a 200. Body-less statuses (101, 204, 205, 304) are now rebuilt with a null body.
- Updated dependencies [9e1af46]
  - @statewalker/httpeers-core@0.1.4

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/httpeers-core@0.1.3
