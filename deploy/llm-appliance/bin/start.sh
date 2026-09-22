#!/usr/bin/env bash
# Brings up the full local appliance -- hub, LiteLLM, Postgres, Traefik and the
# llama.cpp model servers -- and proves it works end to end:
#
#   ./bin/start.sh                     # prepare if never prepared, then up + verify
#   ./bin/start.sh --prepare [flags]   # re-run bin/prepare.sh first, passing it [flags]
#                                      # (e.g. --prepare --backend vulkan --tier small)
#
# Safe to re-run at any time: `up` starts only what is stopped or out of date
# (a service stopped by hand stays down under `restart: unless-stopped` until
# something like this starts it again), and prepare never rotates an existing
# secret unless told to (see README's "Local models").
#
# THE CHECKS, in order: every service healthy (`up --wait`), scripts/health.sh
# (the door, basic auth, the relay reservation), scripts/verify-backend.sh on a
# GPU backend (the model servers really initialised the GPU), and one short
# chat per local model through Traefik. The chat uses the master key rather
# than minting a virtual key, so re-runs leave nothing behind in LiteLLM.
# Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(-f compose.yml -f compose.local.yml -f compose.models.yml)

step() { printf '\n==> %s\n' "$*"; }
die() {
  echo "start: $*" >&2
  exit 1
}

# `!override`/`!reset` in compose.local.yml need Compose >= 2.24. See README's
# "stale ~/.docker/cli-plugins trap" before upgrading Docker over this.
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null)" || die "docker compose not available"
if ! printf '2.24.0\n%s\n' "${COMPOSE_VERSION#v}" | sort -V -C; then
  die "docker compose $COMPOSE_VERSION is older than 2.24 (check ~/.docker/cli-plugins for a stale plugin)"
fi

PREPARE=0
PREPARE_ARGS=()
if [ "${1:-}" = "--prepare" ]; then
  PREPARE=1
  shift
  PREPARE_ARGS=("$@")
elif [ "$#" -gt 0 ]; then
  die "unknown argument: $1 (usage: $0 [--prepare [prepare flags...]])"
fi
for f in .env compose.models.yml litellm/config.local.yaml; do
  [ -f "$f" ] || PREPARE=1
done

if [ "$PREPARE" -eq 1 ]; then
  step "Preparing: probe, pick backend/tier, download models, write .env and generated files"
  ./bin/prepare.sh "${PREPARE_ARGS[@]}"
  chmod 600 .env
fi

step "Starting the stack (the first run builds the hub image and takes a few minutes)"
docker compose "${FILES[@]}" up -d --build --wait --remove-orphans
docker compose "${FILES[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

step "Health: door, auth, relay reservation"
./scripts/health.sh

# shellcheck disable=SC1091
. ./.env
if [ "${LLAMA_BACKEND:-cpu}" != "cpu" ]; then
  step "Backend: the model servers really use the ${LLAMA_BACKEND} GPU"
  ./scripts/verify-backend.sh
fi

step "Chat: one short completion per local model, through Traefik"
# shellcheck disable=SC1091
. ./data/hub/hub.env
DOOR="http://127.0.0.1:${APPLIANCE_DOOR_PORT:-8080}"
LLM="$DOOR/peers/$HUB_PEER_ID/llm"
MODELS="$(sed -n 's/^  - model_name: *//p' litellm/config.local.yaml)"
[ -n "$MODELS" ] || die "no model_name in litellm/config.local.yaml"
for model in $MODELS; do
  reply="$(curl -sS -m 180 "$LLM/v1/chat/completions" \
    -H "x-litellm-api-key: Bearer $LITELLM_MASTER_KEY" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$model\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in three words.\"}]}")" ||
    die "chat with $model: request failed"
  content="$(printf '%s' "$reply" | sed -n 's/.*"content":"\([^"]*\)".*/\1/p')"
  [ -n "$content" ] || die "chat with $model: no reply content: $reply"
  echo "PASS: $model -> $content"
done

cat <<EOF

The appliance is up.
  Admin UI:          $DOOR/   (basic auth: ADMIN_USER / ADMIN_PASSWORD from .env)
  LiteLLM dashboard: $LLM/ui/   (login: UI_USERNAME / UI_PASSWORD from .env)
  OpenAI API base:   $LLM/v1
  Invite a member:   ./bin/invite.sh --roles member
  Stop everything:   docker compose ${FILES[*]} down
EOF
