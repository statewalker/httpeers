#!/usr/bin/env bash
# Probes this host, then hands the probe to a container that decides everything.
#
# THIS SCRIPT INTERPRETS NOTHING. No thresholds, no image names, no backend
# choice. It runs commands that may not exist, tolerates each failing, and
# writes probe.json. Everything downstream is a pure function over that file,
# which is why a probe recorded on a CUDA machine can drive the CUDA path's
# tests on a machine that has no GPU at all.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(cd ../.. && pwd)"

TMPDIR_PROBE="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_PROBE"; }
trap cleanup EXIT

# Runs a command (or, quoted, a pipeline) and writes its raw stdout to
# "$TMPDIR_PROBE/$1". Tolerates the command failing or not existing: a
# missing file in $TMPDIR_PROBE is itself the signal that a probe found
# nothing, which is exactly what the container needs to know.
try() {
  local out="$1"
  shift
  "$@" >"$TMPDIR_PROBE/$out" 2>/dev/null || true
}

try kernel uname -s
try arch uname -m
try os-pretty-name grep '^PRETTY_NAME=' /etc/os-release
try cpu-cores nproc
try mem-total grep MemTotal /proc/meminfo
try docker-engine docker version --format '{{.Server.Version}}'
try docker-compose docker compose version --short
try docker-runtimes docker info --format '{{json .Runtimes}}'
try nvidia-smi nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
try lspci-display bash -c "lspci -nn | grep -Ei 'vga|3d|display'"
try dev-dri ls /dev/dri
try dev-mtgpu bash -c 'ls -d /dev/mtgpu* 2>/dev/null'
try kfd-exit bash -c 'test -e /sys/class/kfd; echo -n $?'

# The container assembles probe.json from these raw files -- never in bash.
# Quoting arbitrary command output into JSON by hand is the kind of thing
# that works until an unusual GPU name contains a quote.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$REPO_ROOT:/work" -v "$TMPDIR_PROBE:/probe:ro" -w /work \
  node:22-alpine \
  node --experimental-strip-types apps/appliance-prepare/src/main.ts \
    --raw-probe /probe --appliance /work/deploy/llm-appliance "$@"
