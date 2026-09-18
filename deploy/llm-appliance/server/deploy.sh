#!/bin/sh
# The LLM appliance's deploy entry point on the httpeers.net server.
#
# INSTALLED BY HAND, NOT BY CI: /opt/httpeers-llm/bin/deploy.sh (see ../README.md, "Server
# deployment"). CI's key is authorised in ~/.ssh/authorized_keys ONLY as
#
#   restrict,command="/opt/httpeers-llm/bin/deploy.sh" ssh-ed25519 AAAA... llm-deploy@httpeers
#
# so whatever command the client sends arrives here as $SSH_ORIGINAL_COMMAND, and this script is
# all that key can run. It accepts exactly:
#
#   deploy <40-hex commit sha>   pull ghcr.io/statewalker/httpeers-hub:sha-<sha>, take the
#                                appliance files FROM THAT IMAGE, bring the stack up, verify,
#                                roll back to the previous release if verification fails
#   redeploy                     the same for the current release (after editing .env)
#   status                       `docker compose ps` of the current release
#
# THE TRUST ANCHOR IS THE REGISTRY. The key cannot pass files, a compose file, or a shell
# command -- only a commit id. What runs is what CI built from this repository and pushed to
# GHCR (which only the repository's workflows can write to). A stolen key can therefore at most
# redeploy an image this repository already built. The compose files travel INSIDE the hub image
# (/appliance, see apps/hub/Dockerfile) for the same reason: config and code are one artefact,
# pinned by one sha.
#
# Layout under $ROOT (default /opt/httpeers-llm):
#   .env                 secrets + COMPOSE_FILE/COMPOSE_PROJECT_NAME, mode 600, never in git
#   data/                hub identity + state, Postgres data -- survives every release
#   releases/<sha>/      the appliance files of one commit, with .env and data symlinked in
#   current -> releases/<sha>
#   deploy.log           one line per deploy
set -eu

ROOT=${LLM_APPLIANCE_ROOT:-/opt/httpeers-llm}
IMAGE_REPO=ghcr.io/statewalker/httpeers-hub
KEEP_RELEASES=3

say() { printf '%s\n' "$*"; }
die() {
  say "DEPLOY FAILED: $*"
  exit 1
}

# Commands come from ssh (forced command) or from argv (an operator on the host).
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # Split on whitespace, with globbing OFF so a `*` stays a `*`; every word is validated below.
  set -f
  # shellcheck disable=SC2086
  set -- $SSH_ORIGINAL_COMMAND
  set +f
fi
CMD=${1:-}

cd "$ROOT" || die "no $ROOT"
[ -f .env ] || die "$ROOT/.env is missing"

hub_peer_id() {
  if [ -f data/hub/hub.env ]; then
    sed -n 's/^HUB_PEER_ID=//p' data/hub/hub.env | tr -d '"' | head -1
  fi
}

current_sha() {
  if [ -L current ]; then basename "$(readlink current)"; fi
}

# Bring up the release directory $1 and verify it. Returns non-zero on any failure.
up_and_verify() {
  dir=$1
  before=$(hub_peer_id)
  (cd "$dir" && docker compose up -d --remove-orphans --wait --wait-timeout 300) || {
    say "compose up --wait failed"
    (cd "$dir" && docker compose ps -a && docker compose logs --tail=30 hub litellm) || true
    return 1
  }
  after=$(hub_peer_id)
  [ -n "$after" ] || {
    say "the hub wrote no HUB_PEER_ID"
    return 1
  }
  # The hub's identity is in every invitation and every member's memory. A new one after a
  # deploy means data/hub was lost -- fail loudly rather than print a line nobody reads.
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    say "the hub's peerId CHANGED: $before -> $after (was data/hub lost?)"
    return 1
  fi
  (cd "$dir" && sh ./scripts/health.sh) || return 1
  # The models LiteLLM serves, through the same door (master key; nothing printed but names).
  models=$(
    cd "$dir" && set -a && . ./.env && set +a &&
      curl -fsS -m 20 -u "$ADMIN_USER:$ADMIN_PASSWORD" \
        -H "x-litellm-api-key: Bearer $LITELLM_MASTER_KEY" \
        "http://127.0.0.1:8080/peers/$after/llm/v1/models" |
      python3 -c 'import json,sys; print(" ".join(m["id"] for m in json.load(sys.stdin)["data"]))'
  ) || {
    say "could not list LiteLLM's models through the door"
    return 1
  }
  [ -n "$models" ] || {
    say "LiteLLM serves no model"
    return 1
  }
  say "hub peerId: $after"
  say "models: $models"
}

prepare_release() {
  sha=$1
  image="$IMAGE_REPO:sha-$sha"
  dir="releases/$sha"
  docker pull -q "$image" >/dev/null || die "cannot pull $image"
  rm -rf "$dir.tmp"
  mkdir -p "$dir.tmp"
  cid=$(docker create "$image")
  docker cp "$cid:/appliance/." "$dir.tmp/" >/dev/null || {
    docker rm "$cid" >/dev/null
    die "$image carries no /appliance"
  }
  docker rm "$cid" >/dev/null
  ln -s ../../.env "$dir.tmp/.env"
  ln -s ../../data "$dir.tmp/data"
  # The one per-release setting: which hub image this release runs.
  printf 'services:\n  hub:\n    image: %s\n' "$image" >"$dir.tmp/compose.release.yml"
  rm -rf "$dir"
  mv "$dir.tmp" "$dir"
}

deploy_release() {
  sha=$1
  previous=$(current_sha)
  if up_and_verify "releases/$sha"; then
    ln -sfn "releases/$sha" current
    printf '%s deploy %s ok (previous %s)\n' "$(date -u +%FT%TZ)" "$sha" "${previous:-none}" >>deploy.log
    say "DEPLOYED $sha"
    prune
    return 0
  fi
  printf '%s deploy %s FAILED (previous %s)\n' "$(date -u +%FT%TZ)" "$sha" "${previous:-none}" >>deploy.log
  if [ -n "$previous" ] && [ "$previous" != "$sha" ]; then
    say "rolling back to $previous"
    if up_and_verify "releases/$previous"; then
      say "rolled back to $previous"
    else
      say "ROLLBACK ALSO FAILED -- the appliance needs a human"
    fi
  fi
  die "release $sha did not verify"
}

prune() {
  keep=$(current_sha)
  # Newest first; keep the current one and the ${KEEP_RELEASES} newest.
  # shellcheck disable=SC2012
  ls -1t releases | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
    [ "$old" = "$keep" ] && continue
    rm -rf "releases/$old"
    docker image rm -f "$IMAGE_REPO:sha-$old" >/dev/null 2>&1 || true
  done
}

# One deploy at a time: a second push while one runs waits rather than interleaving.
exec 9>"$ROOT/.deploy.lock"
flock -w 600 9 || die "another deploy holds the lock"

case "$CMD" in
deploy)
  sha=${2:-}
  [ $# -eq 2 ] || die "usage: deploy <40-hex sha>"
  printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || die "not a commit sha"
  prepare_release "$sha"
  deploy_release "$sha"
  ;;
redeploy)
  [ $# -eq 1 ] || die "usage: redeploy"
  sha=$(current_sha)
  [ -n "$sha" ] || die "nothing deployed yet"
  deploy_release "$sha"
  ;;
status)
  [ $# -eq 1 ] || die "usage: status"
  sha=$(current_sha)
  [ -n "$sha" ] || die "nothing deployed yet"
  say "current: $sha"
  (cd current && docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}')
  ;;
*)
  die "unknown command (deploy <sha> | redeploy | status)"
  ;;
esac
