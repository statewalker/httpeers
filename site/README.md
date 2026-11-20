# @statewalker/httpeers-site

The httpeers website: what the mesh is for, how to use it, its architecture, the package
reference and **live examples that run the libraries in the visitor's tab**. Astro, Tailwind CSS
v4 and shadcn/ui tokens, on the same infrastructure as [cellb.dev](https://cellb.dev)'s site
(statewalker/cellb.dev `site/`): a static build in `dist/`, published to the httpeers static-site
host by `.github/workflows/site.yml`. Private: never published to npm.

```sh
pnpm install                                              # at the repository root
pnpm --filter "@statewalker/httpeers-site..." run build   # the libraries, then the site, into site/dist/
pnpm --filter @statewalker/httpeers-site dev              # http://localhost:4321 (libraries built first)
pnpm --filter @statewalker/httpeers-site check:links      # every internal link and #anchor of dist/ resolves
pnpm --filter @statewalker/httpeers-site check:examples   # runs every live example of dist/ in Chromium
```

The examples import the libraries as an application does, from their `dist/` (the packages'
`exports`), so build the workspace packages before `dev` or after changing one.

## Structure

| path | purpose |
| --- | --- |
| `src/styles/global.css` | All design tokens (shadcn/ui variable contract), light + dark; teal (hue ≈ 195) with a blue secondary |
| `src/components/` | Header, Footer, Logo, ThemeToggle, Icon, CodeBlock (Shiki + copy), MeshDiagram, ExampleRunner; `ui/` holds Button and Badge |
| `src/layouts/` | `Base` (theme bootstrap, header/footer) and `Docs` (sidebar) |
| `src/pages/` | Home, `/docs` (getting started), `/docs/architecture`, `/docs/access` (access control), `/docs/[...slug]` (the repository's Markdown), `/examples` and `/examples/<slug>` |
| `src/examples/<slug>.ts` | The live examples: each exports `run(out)`, which the page runs in the tab and the browser check runs in Chromium |
| `src/lib/examples.ts` | The list of live examples: title, summary, packages, what to look for, and the pages that explain it (`concepts`, shown as "Read more") |
| `src/lib/docs.ts` | Which repository Markdown files become which `/docs/…` pages; the sidebar and `docHref` read it. `relatedPages` lists, per file, the concept pages and examples shown at the top of its page |
| `scripts/compress.mjs` | After `astro build`: `dist/.site/config.json` (the host's options) and `.br`/`.gz` copies of text files |
| `scripts/check-links.mjs` | Walks `dist/` and fails on an internal `href`/`src` that is not a file of the build, or a `#fragment` with no matching `id` |
| `scripts/check-examples.mjs` | Serves `dist/`, opens every example page in Chromium, presses Run, fails on a failed run or a page error |
| `scripts/setup-publish-secrets.sh` | Creates the publishing credentials and sets them on the repository (Publishing, below) |

## Live examples

Each example is one TypeScript module in `src/examples/`. Its page shows that module's source
(imported `?raw`) and its Run button loads the same module, so the code shown is the code run.
They join peers with `pairedLinks` from `@statewalker/httpeers-bridge/ports` (MessagePorts)
instead of libp2p, so they need no relay and send nothing over the network:

| Example | Shows |
| --- | --- |
| `mesh-over-ports` | Two peers serving FetchHandlers to each other; a forged `x-httpeers-peer` overwritten; a 404 from the mount table |
| `access-tokens` | Biscuit tokens minted by a hub, `withAccess` and a Datalog policy: member, admin, no token, a token in the wrong hands, a foreign mesh's token |
| `attenuation` | Alice narrows her membership token (one peer, five minutes) by appending a Biscuit block; it cannot widen or survive a changed byte; then a right passed to Carol with an application token, checked against the proven caller |
| `hub-invitation` | `createHub` in the tab, an invitation as a QR code, redeemed once over the hub's `/.well-known/invite`, refused on replay, then the mesh view with the token |

An example throws (`expect` in `src/examples/output.ts`) when what it demonstrates did not happen,
which is what makes `check:examples` a test. To add one, write `src/examples/<slug>.ts` and add it
to `src/lib/examples.ts`, with the pages that explain it in `concepts`.

The deployed demos (hub, images, app and proxy on `*.httpeers.net`, `apps/demos`) form a real
mesh over the relay; `/examples` links to them and says how to try them.

## Content map

| Page | Source |
| --- | --- |
| Home | the root README (what it is, the libraries, why it is the way it is), `docs/security-model.md` §7 and §9 |
| `/docs` (getting started) | the packages' READMEs: `httpeers-bridge`, `httpeers-libp2p`, `httpeers-member` |
| `/docs/architecture` | `httpeers-core`, `httpeers-member` and `httpeers-access` READMEs, `docs/security-model.md` §1 and §4, `apps/*/README.md` |
| `/docs/access` | `httpeers-access` (README, the design notes in `src/tokens.ts` and `src/rules.ts`), `webrun-biscuit`, `httpeers-hub` (README, `src/endpoints.ts`) |
| `/docs/security`, `/docs/deploy`, `/docs/publish` | `docs/security-model.md`, `deploy/README.md`, `tools/publish/README.md`, rendered at build time |
| `/docs/packages/<name>`, `/docs/apps/<name>` | each package's and app's own README, rendered at build time |

The repository's Markdown is rendered as it is (`src/content.config.ts` loads it as the `repo`
collection), so the same file reads on GitHub and on the site and nothing drifts.
`src/lib/rehype-repo-links.ts` rewrites relative links at build time: a link to a rendered file
goes to its page, any other file to GitHub. To publish another file, add it to `src/lib/docs.ts`,
and to the `paths` filters of `.github/workflows/site.yml` if no filter covers it yet.

## Publishing

`.github/workflows/site.yml` builds the site, checks every internal link (`check:links`) and runs
its live examples in Chromium (`check:examples`) on every pull request that touches it (or the
libraries and READMEs it renders), and publishes it from `main` to the httpeers static-site host
(`apps/sites`), exactly as cellb.dev's site is published. A site there is a first-level prefix of
the `sites` bucket on `https://s3.httpeers.net`, named after its domain; the workflow runs
`rclone sync site/dist httpeers:sites/<domain>`, inside that prefix only, and the host serves it at
once (old files for up to 60 s).

The site's address is **https://httpeers.com**. `httpeers.org`, `www.httpeers.com` and
`www.httpeers.org` redirect to it (`deploy/Caddyfile`). Settings (repository → Settings → Secrets
and variables → Actions):

| Kind | Name | Value |
| --- | --- | --- |
| secret | `HTTPEERS_S3_ACCESS_KEY_ID`, `HTTPEERS_S3_SECRET_ACCESS_KEY` | credentials that can write the site's prefix in the `sites` bucket |
| variable | `SITE_DOMAIN` | optional; `httpeers.com` when unset |

Use credentials of their own, not the pair in `/opt/httpeers/.env` on the server: that pair is
RustFS's own (`tools/publish/README.md`) and can rewrite or delete every site in the bucket. A
RustFS user whose policy allows `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and
`s3:ListBucket` on `sites/httpeers.com/*` only is what this workflow needs.

Without the secrets the workflow builds and checks the site and notes that it did not publish.
Run it by hand with "Run workflow" (`workflow_dispatch`).

### Going live at httpeers.com, once

1. **DNS at Gandi.** `httpeers.com` and `httpeers.org` point at Gandi's parking page today (apex
   `217.70.184.38`, `www` a CNAME to `webredir.vip.gandi.net`). In each domain's **DNS records**,
   set `A @ 163.172.46.87` and `A www 163.172.46.87` (delete the `www` CNAME), and turn off
   **web forwarding** if it is on. `dig +short httpeers.com www.httpeers.org` should print the
   server's address.
2. **Caddy.** Deploy `deploy/Caddyfile` as `deploy/README.md` says ("5. After any change to the
   Caddyfile"). Its `httpeers.com` block serves the site; the `www.httpeers.com, httpeers.org,
   www.httpeers.org` block redirects. Certificates come over HTTP-01, so this step must follow the
   DNS change.
3. **Secrets.** Run `site/scripts/setup-publish-secrets.sh` (needs ssh to the server, docker and
   `gh` with admin rights here). It reads RustFS's root pair over ssh (`HTTPEERS_SSH` to change
   the host), creates or re-keys the RustFS user `httpeers-site` limited to `sites/httpeers.com/*`
   with RustFS's own client (`rc admin`, in a `rustfs/rc` container), checks the new pair can
   write and delete under `sites/httpeers.com/.site/`, and sets the two secrets and `SITE_DOMAIN`
   with `gh`. Running it again rotates the key.
4. **Publish.** `gh workflow run site.yml -R statewalker/httpeers --ref main`, or push to `main`.
5. **Check.** `curl -sI https://httpeers.com/` answers `200`; `curl -sI https://httpeers.org/`
   answers `301` with `location: https://httpeers.com/`.

Until step 2, the workflow can publish to a `*.httpeers.net` name for a preview, with no DNS or
Caddy change: run the script with `SITE_DOMAIN=httpeers-site.httpeers.net
SITE_DOMAINS="httpeers.com httpeers-site.httpeers.net"`. (`www.httpeers.net` will not do: it is a
CNAME to Gandi's web redirector, which wins over the zone's wildcard record.)

## Style

Shared with cellb.dev's site: the shadcn token contract, Inter / JetBrains Mono, bordered cards,
grid background, mono eyebrow labels, code windows, CTA band. Different: teal with a blue
secondary, and the three-peer logo. Edit `:root` / `.dark` in `src/styles/global.css` to re-skin.
