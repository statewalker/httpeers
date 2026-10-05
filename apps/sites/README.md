# @statewalker/httpeers-sites

## What it is

The static-site host behind `*.httpeers.net`. A site is a **first-level prefix
in an S3 bucket, named after its domain**: `abc.httpeers.net/index.html` under
the bucket's prefix. The `Host` header names the prefix, so publishing a site
is writing files — no DNS record, no certificate, no ingress edit, no restart.
Private: deployed as a container image, never published.

## Layout

| File | What it is |
|---|---|
| `src/main.ts` | the process: reads the environment, starts the server |
| `src/host.ts` | `Host` header → site name, validated |
| `src/resolve.ts` | request path → candidate files (pure, table-tested) |
| `src/lookup.ts` | candidate → a file that exists |
| `src/serve.ts` | the Hono app: status, headers, body |
| `src/range.ts`, `src/cache.ts`, `src/content-type.ts` | byte ranges, the resolution cache, media types |
| `src/site-config.ts` | per-site options from `.site/config.json` |
| `src/store.ts` | the only module that knows the storage backend (`s3`, `node`, `mem`) |
| `Dockerfile` | the image (build context: the repository root) |

## How to run it

Against a local directory, where `./www/localhost/index.html` is the site for
`http://localhost:3000/`:

```sh
SITES_ADAPTER=node SITES_ROOT=$PWD/www pnpm --filter @statewalker/httpeers-sites dev
```

In production it runs as `ghcr.io/statewalker/httpeers-sites` behind Caddy, on
RustFS (S3); see [`deploy/README.md`](../../deploy/README.md). To publish a
site, write its files under `<domain>/` in the bucket; `tools/publish` does it
from a folder.

## Why it is the way it is

### The host name is the storage prefix

There is no index to build, nothing to invalidate on publish, and no collision
between sites, because storage keys are unique. The cost is that the `Host`
header becomes a path, so `host.ts` accepts only a valid lowercase host name
(labels of `[a-z0-9-]`, no traversal). Caddy already restricts it, but the app
must not depend on the proxy for correctness: publishing port 3000 directly
would remove that guarantee.

### Resolution is cached, contents are not

Finding a file can take up to three `stats()` probes (`/foo`, `/foo.html`,
`/foo/index.html`). The answer is cached for `SITES_CACHE_TTL_MS` (60 s) in a
bounded map; file bodies never are. There is no publish hook, so a re-published
file can take up to one TTL to appear. Set `SITES_CACHE_TTL_MS=0` while
iterating.

### Responses revalidate by default

A site's `Cache-Control` defaults to `no-cache` ("revalidate every time"), with
a weak `ETag` from size and mtime, so repeat requests cost a 304. Nothing
guarantees a site's assets are content-hashed, and a long `max-age` would leave
a re-published stylesheet stale with no way to flush it. A site whose build
hashes file names opts into real caching in `.site/config.json`:

```json
{ "spa": false, "notFound": "/404.html", "cacheControl": "public, max-age=31536000, immutable" }
```

`spa: true` serves `/index.html` with 200 for unmatched paths. The `.site/`
directory itself is never served. A malformed file is ignored with a warning
(`sites: <site> has a malformed .site/config.json, ignoring it: …`), so a typo
does not take a site offline.

## What will surprise you

- **`/foo` with only `/foo/index.html` returns 301 to `/foo/`.** Serving the
  body at `/foo` would break every relative link in it — `img.png` resolves to
  `/img.png`, not `/foo/img.png` — and the symptom would be missing images, not
  anything that looks like routing.
- **A missing file is a 404, never a 200 with an empty body.** The storage API
  returns an empty stream for a path that does not exist rather than throwing,
  so existence is always checked with `stats()` first.
- **Missing S3 settings fail at startup**, naming them:
  `sites: S3_BUCKET, S3_ACCESS_KEY_ID are required for SITES_ADAPTER=s3`.
- **Path-style S3 addressing is forced**, as RustFS and other self-hosted S3
  servers require; virtual-host addressing would look up `<bucket>.rustfs` as a
  host name.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/httpeers-sites dev` | run from source with `tsx` |
| `pnpm --filter @statewalker/httpeers-sites build` / `start` | compile to `dist/`, run `dist/main.js` |
| `pnpm --filter @statewalker/httpeers-sites test` | the tests |
| `docker build -f apps/sites/Dockerfile .` | the image, from the repository root |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SITES_PORT` | `3000` | the port to listen on |
| `SITES_ADAPTER` | `s3` | `s3`, `node` or `mem` |
| `SITES_ROOT` | — | the directory, for `node` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | required for `s3` |
| `S3_REGION` | `us-east-1` | |
| `S3_PREFIX` | none | a prefix inside the bucket under which the sites live |
| `SITES_CACHE_TTL_MS` | `60000` | resolution cache TTL; `0` disables it |
| `SITES_CACHE_MAX` | `10000` | resolution cache entries |
