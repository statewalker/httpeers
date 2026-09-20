#!/usr/bin/env bash
# Mints an invitation through the local door and writes it out blob-first
# into invites/<date>-<roles>/:
#
#   blob.txt  -- the join blob alone, THE PRIMARY ARTIFACT. Any application
#                that understands the blob format can join with this file's
#                exact contents -- pasted, scanned, or read directly.
#   blob.png  -- a QR of the BLOB (not of the link below). Round-tripped
#                through this repo's own decoder before this script exits.
#   link.txt  -- a convenience URL that hands the blob to HUB_JOIN_PAGE_URL.
#                One way to spend the blob, not the credential itself.
#
# Usage: ./bin/invite.sh --roles member [--roles admin ...] --ttl-days 7
# (--roles may repeat, or be comma-separated: --roles member,admin.
#  --ttl-days is optional; omitted, the hub applies its own default TTL.)
#
# Run from deploy/llm-appliance. Requires .env (secrets, the door port) and
# data/hub/hub.env (the hub's own peer id, to verify against) -- i.e. the
# appliance must already be running.
#
# Mints via a plain curl-shaped fetch from a container on the HOST's network
# (--network host), so 127.0.0.1:$APPLIANCE_DOOR_PORT reaches Traefik's door
# exactly as a curl run on the host would (see scripts/health.sh). Generates
# and verifies the QR by running Node inside a stock node:22-alpine with this
# repo bind-mounted -- the same pattern bin/prepare.sh uses -- so the
# operator needs only Docker and a clone, never a host Node/pnpm install.
# UNLIKE bin/prepare.sh (stdlib only), its FIRST run needs outbound registry
# access: bin/qr-deps.ts installs packages/httpeers-qr's own qrcode-generator
# and jsqr from npm, at the versions that package.json declares, once, and
# caches them in this repo's own node_modules for every run after.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(cd ../.. && pwd)"

if [ ! -f .env ]; then
  echo "invite: .env not found (cp .env.example .env, fill it in, and rerun)" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a
. ./.env
set +a

if [ ! -f data/hub/hub.env ]; then
  echo "invite: data/hub/hub.env not found -- is the appliance up? (docker compose up -d)" >&2
  exit 1
fi
# shellcheck disable=SC1091
. ./data/hub/hub.env

ROLES=()
TTL_DAYS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --roles)
      IFS=',' read -ra PARTS <<<"$2"
      ROLES+=("${PARTS[@]}")
      shift 2
      ;;
    --ttl-days)
      TTL_DAYS="$2"
      shift 2
      ;;
    *)
      echo "invite: unknown argument: $1 (usage: --roles member [--roles admin ...] [--ttl-days N])" >&2
      exit 1
      ;;
  esac
done

if [ "${#ROLES[@]}" -eq 0 ]; then
  echo "invite: at least one --roles is required, e.g. --roles member" >&2
  exit 1
fi

ROLES_JSON="["
for i in "${!ROLES[@]}"; do
  [ "$i" -gt 0 ] && ROLES_JSON+=","
  ROLES_JSON+="\"${ROLES[$i]}\""
done
ROLES_JSON+="]"

TTL_MS=""
if [ -n "$TTL_DAYS" ]; then
  TTL_MS=$((TTL_DAYS * 24 * 60 * 60 * 1000))
fi

ROLES_TAG="$(IFS=+; echo "${ROLES[*]}")"
DATE_TAG="$(date -u +%Y-%m-%d)"
OUT_DIR="invites/${DATE_TAG}-${ROLES_TAG}"
mkdir -p "$OUT_DIR"

docker run --rm --network host \
  --user "$(id -u):$(id -g)" \
  -v "$REPO_ROOT:/work" -w /work/deploy/llm-appliance \
  -e "HOME=/tmp" \
  -e "ADMIN_USER=${ADMIN_USER:-admin}" \
  -e "ADMIN_PASSWORD=${ADMIN_PASSWORD:-}" \
  -e "DOOR_PORT=${APPLIANCE_DOOR_PORT:-8080}" \
  -e "ROLES_JSON=${ROLES_JSON}" \
  -e "TTL_MS=${TTL_MS}" \
  -e "OUT_DIR=${OUT_DIR}" \
  -e "EXPECTED_HUB_PEER_ID=${HUB_PEER_ID:-}" \
  node:22-alpine sh -c '
    set -e
    node --experimental-strip-types bin/qr-deps.ts
    node --experimental-strip-types bin/invite.ts
  '

echo ""
echo "invite: wrote $OUT_DIR/blob.txt, $OUT_DIR/blob.png, $OUT_DIR/link.txt"
