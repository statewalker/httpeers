# The hub daemon image. Built from the MONOREPO ROOT as build context
# (`deploy/llm-appliance/compose.yml` sets `build.context: ../..`,
# `dockerfile: apps/hub/Dockerfile`) — the hub depends on workspace packages
# under `packages/`, so the whole workspace has to be in the build context,
# not just this directory.
#
# `apps/relay` is copied too even though the runtime image never runs it:
# `apps/hub`'s package.json carries `@statewalker/httpeers-relay: workspace:*`
# as a devDependency (used by the hub's own e2e test), and pnpm's workspace
# resolution fails outright — even for a `--prod` install/deploy — if a
# workspace project a manifest refers to is not present on disk at all
# (VERIFIED: `pnpm install --frozen-lockfile --filter
# "@statewalker/httpeers-hub-daemon..."` and `pnpm deploy` both error with
# `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` for `@statewalker/httpeers-relay` when
# `apps/relay/` is missing from the tree, even though the deploy is `--prod`
# and never installs it). `apps/relay` has no heavy dependencies of its own,
# so this costs nothing.
#
# `pnpm-workspace.yaml` MUST be copied before `pnpm install`: since the
# upstream merge (native TypeScript Biscuit), it carries
# `onlyBuiltDependencies`, including `node-datachannel` — `@libp2p/webrtc`'s
# native dependency, whose install script fetches a prebuilt `.node` binary.
# pnpm 10 silently skips that script for any package not named there, and the
# workspace looks fine until something actually imports `node-datachannel` at
# runtime. Without this file in the build context, the image would build
# clean and fail at the first WebRTC connection instead of at build time.
#
# `pnpm deploy ... --legacy --config.node-linker=hoisted` (not the plain
# isolated store `pnpm deploy` pnpm 10 defaults to): a plain deploy produces a
# pnpm-style node_modules (a handful of top-level symlinks into a `.pnpm`
# virtual store), where a transitive dependency like `node-datachannel`
# (pulled in by `@libp2p/webrtc`, not a direct dependency of this package) is
# NOT resolvable from the deployed root — VERIFIED: `node -e
# "require.resolve('node-datachannel')"` fails from such a tree (and fails
# today from `apps/hub` in the live monorepo checkout too, for the same
# reason — this is not a regression). `--config.node-linker=hoisted` produces
# a flat, npm-style node_modules where it resolves, which is what lets the
# image-level verification (`node -e "import('node-datachannel')"`) work at
# all, and is generally the safer shape for a container image that other
# tooling might introspect.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

# Manifests and workspace config first, for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/hub ./apps/hub
COPY apps/relay ./apps/relay

RUN corepack prepare pnpm@10.16.0 --activate \
  && pnpm install --frozen-lockfile --filter "@statewalker/httpeers-hub-daemon..."

# Builds every workspace dependency first (tsc), then this package
# (tsc + `build:ui`, which produces `dist-ui/` — the admin UI Task 6 built).
RUN pnpm --filter "@statewalker/httpeers-hub-daemon..." run build

# A self-contained, production-only `/out`: `dist/`, `dist-ui/`, and a flat
# `node_modules` — see the module comment for why `--legacy
# --config.node-linker=hoisted` and not a plain `pnpm deploy`.
RUN pnpm deploy --filter "@statewalker/httpeers-hub-daemon" --prod --legacy \
      --config.node-linker=hoisted /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
VOLUME /data
CMD ["node", "dist/main.js"]
