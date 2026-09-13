# @statewalker/httpeers-sites

The static-site host: one site per storage prefix. **Private** — deployed as an image,
never published.

A site is a **first-level prefix in an S3 bucket, named after its domain**:
`sites/abc.httpeers.net/index.html`. Publishing is writing files — no DNS record, no
certificate, no ingress edit, no restart. The `Host` header resolves directly to a prefix,
so there is no index to build, nothing to invalidate, and collisions are impossible
because storage enforces key uniqueness.

```sh
pnpm --filter @statewalker/httpeers-sites dev
```

| Module | What it is |
|---|---|
| `host.ts`, `lookup.ts`, `resolve.ts` | `Host` header → storage prefix → a file |
| `serve.ts` | The response: status, headers, body |
| `range.ts` | Byte ranges |
| `cache.ts` | Validators and cache headers |
| `content-type.ts` | Extension → media type |
| `store.ts` | The **only** module that knows which backend is in use (`s3` \| `node` \| `mem`) |
| `site-config.ts` | Per-site configuration |

Two behaviours worth knowing, both easy to get wrong and both pinned by tests:

- **`/foo` matching `/foo/index.html` returns 301 to `/foo/`.** Serving the body at the
  un-slashed URL breaks every relative link in the document — `img.png` resolves to
  `/img.png`, not `/foo/img.png` — and the symptom is missing images, not anything that
  looks like routing.
- **A missing file is a 404, never a 200 with an empty body.** `FilesApi.read()` returns
  an empty iterable for a path that does not exist rather than throwing, so existence is
  always established with `stats()` first.

Deployment and configuration are in the [repository README](../../README.md).

**83 tests.**
