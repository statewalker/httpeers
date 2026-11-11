---
"@statewalker/httpeers-ghost": patch
---

`contain` in `sandbox` mode keeps a non-HTML response's status and status text. It used to rebuild the response with `{ ...response, headers }`, which copies neither (they are prototype getters), so a 404 or 304 asset reached the frame as a 200. Body-less statuses (101, 204, 205, 304) are now rebuilt with a null body.
