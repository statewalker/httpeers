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
| `src/pages/` | Home, `/docs` (getting started), `/docs/architecture`, `/docs/[...slug]` (the repository's Markdown), `/examples` and `/examples/<slug>` |
| `src/examples/<slug>.ts` | The live examples: each exports `run(out)`, which the page runs in the tab and the browser check runs in Chromium |
| `src/lib/examples.ts` | The list of live examples: title, summary, packages, what to look for |
| `src/lib/docs.ts` | Which repository Markdown files become which `/docs/…` pages; the sidebar and `docHref` read it |
| `scripts/compress.mjs` | After `astro build`: `dist/.site/config.json` (the host's options) and `.br`/`.gz` copies of text files |
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
| `hub-invitation` | `createHub` in the tab, an invitation as a QR code, redeemed once over the hub's `/.well-known/invite`, refused on replay, then the mesh view with the token |

An example throws (`expect` in `src/examples/output.ts`) when what it demonstrates did not happen,
which is what makes `check:examples` a test. To add one, write `src/examples/<slug>.ts` and add it
to `src/lib/examples.ts`.

The deployed demos (hub, images, app and proxy on `*.httpeers.net`, `apps/demos`) form a real
mesh over the relay; `/examples` links to them and says how to try them.

## Content map

| Page | Source |
| --- | --- |
| Home | the root README (what it is, the libraries, why it is the way it is), `docs/security-model.md` §7 and §9 |
| `/docs` (getting started) | the packages' READMEs: `httpeers-bridge`, `httpeers-libp2p`, `httpeers-member` |
| `/docs/architecture` | `httpeers-core`, `httpeers-member` and `httpeers-access` READMEs, `docs/security-model.md` §1 and §4, `apps/*/README.md` |
| `/docs/security`, `/docs/deploy`, `/docs/publish` | `docs/security-model.md`, `deploy/README.md`, `tools/publish/README.md`, rendered at build time |
| `/docs/packages/<name>`, `/docs/apps/<name>` | each package's and app's own README, rendered at build time |

The repository's Markdown is rendered as it is (`src/content.config.ts` loads it as the `repo`
collection), so the same file reads on GitHub and on the site and nothing drifts.
`src/lib/rehype-repo-links.ts` rewrites relative links at build time: a link to a rendered file
goes to its page, any other file to GitHub. To publish another file, add it to `src/lib/docs.ts`,
and to the `paths` filters of `.github/workflows/site.yml` if no filter covers it yet.

## Publishing

`.github/workflows/site.yml` builds the site and runs its live examples in Chromium on every pull
request that touches it (or the libraries and READMEs it renders), and publishes it from `main` to
the httpeers static-site host (`apps/sites`), exactly as cellb.dev's site is published. A site
there is a first-level prefix of the `sites` bucket on `https://s3.httpeers.net`, named after its
domain; the workflow runs `rclone sync site/dist httpeers:sites/<domain>`, inside that prefix only,
and the host serves it at once (old files for up to 60 s).

Setup, once (repository → Settings → Secrets and variables → Actions):

| Kind | Name | Value |
| --- | --- | --- |
| secret | `HTTPEERS_S3_ACCESS_KEY_ID`, `HTTPEERS_S3_SECRET_ACCESS_KEY` | credentials that can write the site's prefix in the `sites` bucket |
| variable | `SITE_DOMAIN` | optional; `www.httpeers.net` when unset |

Use credentials of their own, not the pair in `/opt/httpeers/.env` on the server: that pair is
RustFS's own (`tools/publish/README.md`) and can rewrite or delete every site in the bucket. A
RustFS user whose policy allows `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and
`s3:ListBucket` on `sites/www.httpeers.net/*` and `sites/httpeers.net/*` only is what this
workflow needs.

`site/scripts/setup-publish-secrets.sh` does all of it: it reads the root pair over ssh
(`HTTPEERS_SSH` to change the host), creates or re-keys that user (`httpeers-site`) with RustFS's
own client (`rc admin`, in a `rustfs/rc` container), checks the new pair can write and delete
under `sites/<domain>/.site/`, and sets the two secrets and `SITE_DOMAIN` with `gh`. Running it
again rotates the key.

Without the secrets the workflow builds and checks the site and notes that it did not publish.
Run it by hand with "Run workflow" (`workflow_dispatch`).

`www.httpeers.net` needs nothing else: `*.httpeers.net` in `deploy/Caddyfile` already sends every
subdomain to the sites host, under the wildcard certificate and DNS record. To serve the site at
the apex, `httpeers.net`, instead:

1. Add a site block to `deploy/Caddyfile` that sends the name to the sites host, and deploy it
   (the wildcard certificate does not cover the apex; the `acme` snippet issues one for it).
   Optionally redirect `www.httpeers.net` there with an exact-name block, as `www.cellb.dev` is:

   ```caddyfile
   httpeers.net {
   	import acme
   	reverse_proxy sites:3000
   }
   ```

2. Check the apex resolves to the server: the `@` record of `deploy/README.md`'s DNS step.
3. Set the variable `SITE_DOMAIN` to `httpeers.net` and run the workflow. The old prefix stays
   served until it is removed (`httpeers-publish --delete-site`).

## Style

Shared with cellb.dev's site: the shadcn token contract, Inter / JetBrains Mono, bordered cards,
grid background, mono eyebrow labels, code windows, CTA band. Different: teal with a blue
secondary, and the three-peer logo. Edit `:root` / `.dark` in `src/styles/global.css` to re-skin.
