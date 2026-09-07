# The relay image.
#
# Built from the repository root as context, because pnpm needs the workspace
# manifests to resolve the app's dependencies:
#
#   docker build -f apps/relay/Dockerfile .
#
# NOTHING SECRET IS BAKED IN. The relay's signing key is its identity and must
# outlive the container -- it arrives on a mounted volume at runtime, never
# here. See apps/relay/src/key.ts.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /app
# Without this pnpm refuses to remove a modules directory when there is no TTY,
# which is every container build and every CI run.
ENV CI=true
# Manifests first, so a dependency-free source change does not re-resolve.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay/package.json apps/relay/
RUN pnpm install --frozen-lockfile --filter @statewalker/httpeers-relay...
COPY tsconfig.base.json ./
COPY apps/relay apps/relay
RUN pnpm --filter @statewalker/httpeers-relay run build
# Re-resolve without dev dependencies for the runtime layer.
RUN pnpm install --frozen-lockfile --prod --filter @statewalker/httpeers-relay...

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/relay/node_modules apps/relay/node_modules
COPY --from=build /app/apps/relay/dist apps/relay/dist
COPY --from=build /app/apps/relay/package.json apps/relay/package.json

# The key lives here, on a volume. Owned by the unprivileged user that runs the
# process, because key.ts writes it with mode 0600 when seeding.
RUN mkdir -p /data/.httpeers && chown -R node:node /data
# buildkit warns SecretsUsedInArgOrEnv on the name -- it is a false positive.
# This is a PATH; the key itself arrives on the volume at runtime and is never
# baked in. The default has to point at the volume, or a plain `docker run`
# would write the identity into the container's own filesystem and lose it on
# the next deploy.
ENV RELAY_KEY_PATH=/data/.httpeers/relay.key
VOLUME ["/data"]

# The bootstrap document, which Caddy publishes at
# /.well-known/httpeers-relay.json. CHOWNED FOR THE SAME REASON /data IS: the
# process runs as `node`, so a directory owned by root fails the write AFTER
# startup has succeeded -- a relay that is running, healthy, and whose document
# is silently absent. Docker copies this ownership into an empty named volume
# when it first mounts one here.
RUN mkdir -p /srv/bootstrap/.well-known && chown -R node:node /srv/bootstrap
ENV RELAY_BOOTSTRAP_PATH=/srv/bootstrap/.well-known/httpeers-relay.json
VOLUME ["/srv/bootstrap"]

ENV RELAY_PORT=9090
EXPOSE 9090

USER node
CMD ["node", "apps/relay/dist/main.js"]
