#!/bin/sh
# Waits for the hub's identity, then execs LiteLLM's own entrypoint with
# SERVER_ROOT_PATH pinned to this hub's mesh path.
#
# WHY THIS EXISTS: LiteLLM needs SERVER_ROOT_PATH set before it starts (it
# rewrites the exported UI's asset paths at startup, once — spike finding Q2).
# The hub's peerId is not known until the hub container creates
# `/data/hub/hub.env` on its first run (`apps/hub/src/identity.ts`), so this
# waits for that file, sources it, and only then starts LiteLLM.
#
# `/data/hub/` is mounted read-only here (compose.yml) — this container only
# ever reads the hub's identity, never writes to its data directory.
#
# `hub.env` changes ONLY IF the hub loses its key (`hub.key` deleted). A
# restart with the same key keeps the same HUB_PEER_ID, so LiteLLM never
# needs to be told to re-read it — see README's "Backup and data" section.
set -eu

HUB_ENV_FILE=/data/hub/hub.env
WAIT_SECONDS=120

i=0
while [ ! -f "$HUB_ENV_FILE" ]; do
  if [ "$i" -ge "$WAIT_SECONDS" ]; then
    echo "litellm-entrypoint: timed out after ${WAIT_SECONDS}s waiting for $HUB_ENV_FILE" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

# shellcheck disable=SC1090
. "$HUB_ENV_FILE"

if [ -z "${HUB_PEER_ID:-}" ]; then
  echo "litellm-entrypoint: $HUB_ENV_FILE did not set HUB_PEER_ID" >&2
  exit 1
fi

export SERVER_ROOT_PATH="/peers/${HUB_PEER_ID}/llm"
# A fixed, recognizable sentinel, never a real origin — see
# `apps/hub/src/services/llm/rewrite.ts` and the spike's
# "origin-agnostic rewriting" follow-up: the hub's own passthrough strips this
# origin (and the bind-address one Starlette's StaticFiles redirect leaks)
# from every response, so the UI works from any client origin without
# per-origin LiteLLM configuration.
export PROXY_BASE_URL="http://llm.mesh.invalid"

echo "litellm-entrypoint: HUB_PEER_ID=${HUB_PEER_ID} SERVER_ROOT_PATH=${SERVER_ROOT_PATH}"

# The image's own entrypoint (verified with `docker image inspect` against
# ghcr.io/berriai/litellm:main-v1.83.14-stable: Entrypoint
# ["docker/prod_entrypoint.sh"], resolved at /app/docker/prod_entrypoint.sh,
# WORKDIR /app) — it just `exec`s `litellm "$@"`. `--config`/`-c` and `--port`
# are litellm's own CLI flags (`litellm --help`, verified against this image).
exec /app/docker/prod_entrypoint.sh --config /app/config.yaml --port 4000
