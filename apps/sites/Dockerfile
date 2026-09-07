# The static-site host image.
#
# Built from the repository root as context, because pnpm needs the workspace
# manifests to resolve the app's dependencies:
#
#   docker build -f apps/sites/Dockerfile .
#
# NOTHING SECRET IS BAKED IN. S3 credentials arrive as environment variables at
# runtime, never here.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /app
# Without this pnpm refuses to remove a modules directory when there is no TTY,
# which is every container build and every CI run.
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/sites/package.json apps/sites/
RUN pnpm install --frozen-lockfile --filter @statewalker/httpeers-sites...
COPY tsconfig.base.json ./
COPY apps/sites apps/sites
RUN pnpm --filter @statewalker/httpeers-sites run build
RUN pnpm install --frozen-lockfile --prod --filter @statewalker/httpeers-sites...

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/sites/node_modules apps/sites/node_modules
COPY --from=build /app/apps/sites/dist apps/sites/dist
COPY --from=build /app/apps/sites/package.json apps/sites/package.json
ENV SITES_PORT=3000
EXPOSE 3000
USER node
CMD ["node", "apps/sites/dist/main.js"]
