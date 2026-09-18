#!/bin/sh
# Smoke-checks the appliance through the same door a real client uses:
# Traefik, on 127.0.0.1:8080 (basic auth except on LiteLLM's own paths). Run from deploy/llm-appliance:
#
#   ./scripts/health.sh
#
# Reads .env for credentials — never run this against a directory without one.
# Prints PASS/FAIL per check; exits non-zero if any check failed.
set -u
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "health: .env not found (cp .env.example .env, fill it in, and rerun)" >&2
  exit 1
fi
# shellcheck disable=SC1091
. ./.env

FAILED=0
pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAILED=1
}

# 1. The hub logged READY (apps/hub/src/daemon.ts prints "READY <peerId>" once
# both ways in are serving).
if docker compose logs hub 2>/dev/null | grep -q "READY "; then
  pass "hub logged READY"
else
  fail "hub has not logged READY (docker compose logs hub)"
fi

# 2. hub.env exists — the hub's identity, and what LiteLLM waits on.
HUB_ENV_FILE=./data/hub/hub.env
if [ -f "$HUB_ENV_FILE" ]; then
  pass "$HUB_ENV_FILE exists"
  # shellcheck disable=SC1090
  . "$HUB_ENV_FILE"
else
  fail "$HUB_ENV_FILE does not exist"
fi

if [ -z "${HUB_PEER_ID:-}" ]; then
  fail "HUB_PEER_ID not available (hub.env missing or malformed) — skipping the remaining checks"
  echo ""
  echo "$([ "$FAILED" -eq 0 ] && echo ALL PASS || echo SOME FAILED)"
  exit "$FAILED"
fi

AUTH="${ADMIN_USER:-admin}:${ADMIN_PASSWORD:-}"
BASE="http://127.0.0.1:8080"

# 3. Through Traefik, with basic auth: the admin REST API.
STATUS=$(curl -s -o /tmp/health-mesh.json -w '%{http_code}' -u "$AUTH" "$BASE/hub/api/mesh")
if [ "$STATUS" = "200" ] && grep -q "$HUB_PEER_ID" /tmp/health-mesh.json 2>/dev/null; then
  pass "GET /hub/api/mesh through Traefik (200, hubPeerId matches)"
else
  fail "GET /hub/api/mesh through Traefik -> $STATUS (expected 200 with hubPeerId $HUB_PEER_ID)"
fi
rm -f /tmp/health-mesh.json

# 4. LiteLLM readiness, under the mesh root path, through the door. LiteLLM's
# paths carry NO basic auth (traefik/dynamic.yml's `litellm` router): only
# LiteLLM's own authentication. So no -u here.
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/peers/$HUB_PEER_ID/llm/health/readiness")
if [ "$STATUS" = "200" ]; then
  pass "GET /peers/$HUB_PEER_ID/llm/health/readiness through Traefik (200)"
else
  fail "GET /peers/$HUB_PEER_ID/llm/health/readiness through Traefik -> $STATUS (expected 200)"
fi

# 5. The curated LLM OpenAPI document, through the door (no basic auth).
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/peers/$HUB_PEER_ID/llm/openapi.json")
if [ "$STATUS" = "200" ]; then
  pass "GET /peers/$HUB_PEER_ID/llm/openapi.json through Traefik (200)"
else
  fail "GET /peers/$HUB_PEER_ID/llm/openapi.json through Traefik -> $STATUS (expected 200)"
fi

# 5b. What still needs basic auth, and what LiteLLM guards itself.
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hub/api/mesh")
if [ "$STATUS" = "401" ]; then
  pass "GET /hub/api/mesh without basic auth is refused (401)"
else
  fail "GET /hub/api/mesh without basic auth -> $STATUS (expected 401)"
fi
# The hub's key-minting route uses the master key and checks no caller itself.
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{}' "$BASE/peers/$HUB_PEER_ID/llm/keys")
if [ "$STATUS" = "401" ]; then
  pass "POST /peers/$HUB_PEER_ID/llm/keys without basic auth is refused (401)"
else
  fail "POST /peers/$HUB_PEER_ID/llm/keys without basic auth -> $STATUS (expected 401)"
fi
# LiteLLM's own authentication: an admin route with no key must be refused by LiteLLM.
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/peers/$HUB_PEER_ID/llm/key/list")
if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
  pass "GET /peers/$HUB_PEER_ID/llm/key/list without a LiteLLM key is refused by LiteLLM ($STATUS)"
else
  fail "GET /peers/$HUB_PEER_ID/llm/key/list without a LiteLLM key -> $STATUS (expected 401)"
fi

# 6. The door refuses anyone but Traefik. A Linux host routes to container
# bridge IPs, so "not published" alone is not a gate: straight to the hub
# container's own address, without the door secret, must be 401 (or not
# reachable at all, e.g. Docker Desktop, where bridge IPs are not routed).
HUB_CID=$(docker compose ps -q hub 2>/dev/null)
HUB_IPS=""
if [ -n "$HUB_CID" ]; then
  HUB_IPS=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$HUB_CID" 2>/dev/null)
fi
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$HUB_CID" 2>/dev/null)" = "host" ] && HUB_IPS="127.0.0.1"
if [ -z "$(echo "$HUB_IPS" | tr -d ' ')" ]; then
  fail "no address found for the hub container — cannot check the door refuses direct requests"
else
  for IP in $HUB_IPS; do
    STATUS=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$IP:8787/hub/api/mesh")
    if [ "$STATUS" = "401" ] || [ "$STATUS" = "000" ]; then
      pass "direct to the hub at $IP:8787 without the door secret is refused ($STATUS)"
    else
      fail "direct to the hub at $IP:8787 without the door secret -> $STATUS (expected 401)"
    fi
  done
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "SOME FAILED"
fi
exit "$FAILED"
