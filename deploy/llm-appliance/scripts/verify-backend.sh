#!/usr/bin/env bash
# Proves the GPU was actually used, which `docker compose config` cannot.
set -euo pipefail
cd "$(dirname "$0")/.."
BACKEND="$(grep -E '^LLAMA_BACKEND=' .env | cut -d= -f2-)"
for service in $(docker compose -f compose.yml -f compose.local.yml -f compose.models.yml config --services | grep '^llamacpp-'); do
  LOG="$(docker compose -f compose.yml -f compose.local.yml -f compose.models.yml logs --no-color "$service" 2>&1)"
  printf '%s' "$LOG" | docker run --rm -i -v "$(cd ../.. && pwd):/work" -w /work node:22-alpine \
    node --experimental-strip-types apps/appliance-prepare/src/verify-backend-cli.ts "$BACKEND" "$service"
done
