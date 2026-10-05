#!/bin/sh
# The edge stack's deploy entry point on the httpeers.net server (relay, sites).
#
# INSTALLED BY HAND, NOT BY CI: <DEPLOY_PATH>/bin/deploy.sh (see ../README.md, "Deploys from
# CI"). CI's key is authorised in ~/.ssh/authorized_keys ONLY as
#
#   restrict,command="<DEPLOY_PATH>/bin/deploy.sh" ssh-ed25519 AAAA... edge-deploy@httpeers
#
# so whatever command the client sends arrives here as $SSH_ORIGINAL_COMMAND, and this script is
# all that key can run. It accepts exactly:
#
#   deploy relay|sites <40-hex commit sha>   run ghcr.io/statewalker/httpeers-<service>:sha-<sha>,
#                                            verify it, go back to the previous image if it fails
#   status                                   the services and the images they run
#
# THE TRUST ANCHOR IS THE REGISTRY, as for the LLM appliance (llm-appliance/server/deploy.sh):
# the key can name a service and a commit, nothing else. What runs is what CI built from this
# repository and pushed to GHCR. A stolen key can at most redeploy an image this repository
# already built -- unlike a plain docker-group key, which is root on the host.
#
# The running image of each service is pinned in $ROOT/images.env (RELAY_IMAGE=..., SITES_IMAGE=...),
# which docker-compose.yml reads (`image: ${RELAY_IMAGE:-...:latest}`). The caddy and rustfs
# services are not deployed from here: restarting the TLS terminator or the storage is a human's
# call.
set -eu

ROOT=${EDGE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
REGISTRY=ghcr.io/statewalker

say() { printf '%s\n' "$*"; }
die() {
  say "DEPLOY FAILED: $*"
  exit 1
}

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # Split on whitespace with globbing off; every word is validated below.
  set -f
  # shellcheck disable=SC2086
  set -- $SSH_ORIGINAL_COMMAND
  set +f
fi
CMD=${1:-}

cd "$ROOT" || die "no $ROOT"
[ -f docker-compose.yml ] || die "$ROOT/docker-compose.yml is missing"
touch images.env

# The pinned image of a service ("" when it still runs :latest).
pinned() { sed -n "s/^$(var "$1")=//p" images.env | tail -1; }
var() { printf '%s_IMAGE' "$1" | tr '[:lower:]' '[:upper:]'; }
pin() {
  grep -v "^$(var "$1")=" images.env >images.env.tmp || true
  if [ -n "$2" ]; then printf '%s=%s\n' "$(var "$1")" "$2" >>images.env.tmp; fi
  mv images.env.tmp images.env
}
compose() { (set -a && . ./images.env && set +a && docker compose "$@"); }

relay_peer_id() { compose logs --tail=200 relay 2>&1 | grep -oE '12D3[A-Za-z0-9]{40,}' | tail -1 || true; }

# Verify a freshly started service. Status lines only, never container logs: this output lands
# in the Actions log of a PUBLIC repository.
verify() {
  case "$1" in
  relay)
    after=""
    for _ in $(seq 1 30); do
      after=$(relay_peer_id)
      [ -n "$after" ] && break
      sleep 2
    done
    [ -n "$after" ] || {
      say "the relay reported no peerId within 60s"
      return 1
    }
    # The peerId is in every multiaddr clients dial: a new one invalidates them all at once.
    if [ -n "$BEFORE" ] && [ "$BEFORE" != "$after" ]; then
      say "the relay's peerId CHANGED: $BEFORE -> $after (was the relay_key volume lost?)"
      return 1
    fi
    log=$(compose logs --tail=200 relay 2>&1 || true)
    # A relay advertising a container-internal address starts, looks healthy, and is undialable.
    printf '%s' "$log" | grep -q '/dns4/' || {
      say "the relay advertises no /dns4/ address"
      return 1
    }
    if printf '%s' "$log" | grep -qE '0\.0\.0\.0|/ip4/172\.'; then
      say "the relay advertises a container-internal address"
      return 1
    fi
    say "relay peerId: $after"
    ;;
  sites)
    code=""
    for _ in $(seq 1 30); do
      code=$(compose exec -T sites node -e '
        fetch("http://127.0.0.1:3000/", { headers: { Host: "healthcheck.invalid" } })
          .then((r) => { console.log(r.status); process.exit(0); })
          .catch(() => process.exit(1));
      ' 2>/dev/null || true)
      [ -n "$code" ] && break
      sleep 2
    done
    [ -n "$code" ] || {
      say "sites did not answer within 60s"
      return 1
    }
    say "sites answering; unknown host -> HTTP $code (404 expected)"
    ;;
  esac
}

up() {
  compose up -d "$1" >/dev/null 2>&1 || {
    say "compose up $1 failed"
    compose ps -a --format 'table {{.Service}}\t{{.Status}}' || true
    return 1
  }
}

exec 9>"$ROOT/.deploy.lock"
flock -w 600 9 || die "another deploy holds the lock"

case "$CMD" in
deploy)
  [ $# -eq 3 ] || die "usage: deploy relay|sites <40-hex sha>"
  service=$2
  sha=$3
  case "$service" in relay | sites) ;; *) die "unknown service: $service" ;; esac
  printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || die "not a commit sha"
  image="$REGISTRY/httpeers-$service:sha-$sha"
  previous=$(pinned "$service")
  BEFORE=""
  [ "$service" = relay ] && BEFORE=$(relay_peer_id)
  docker pull -q "$image" >/dev/null || die "cannot pull $image"
  pin "$service" "$image"
  if up "$service" && verify "$service"; then
    printf '%s deploy %s %s ok (previous %s)\n' "$(date -u +%FT%TZ)" "$service" "$sha" "${previous:-latest}" >>deploy.log
    say "DEPLOYED $service $sha"
    exit 0
  fi
  printf '%s deploy %s %s FAILED (previous %s)\n' "$(date -u +%FT%TZ)" "$service" "$sha" "${previous:-latest}" >>deploy.log
  say "rolling back $service to ${previous:-the :latest image}"
  pin "$service" "$previous"
  if up "$service" && verify "$service"; then
    say "rolled back"
  else
    say "ROLLBACK ALSO FAILED -- $service needs a human"
  fi
  die "$service $sha did not verify"
  ;;
status)
  [ $# -eq 1 ] || die "usage: status"
  compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
  ;;
*)
  die "unknown command (deploy relay|sites <sha> | status)"
  ;;
esac
