# @statewalker/httpeers-appliance-prepare

## What it is

The tool behind `deploy/llm-appliance/bin/prepare.sh`: it reads a probe of the
host's hardware, picks a llama.cpp backend (`cpu`, `cuda`, `vulkan`, `intel` or `musa`) and a
memory tier, downloads the tier's GGUF models from Hugging Face, and writes the
local-model appliance's configuration — `.env` (secrets preserved),
`compose.models.yml`, `litellm/config.local.yaml` and, with `--llamaswap`,
`llamaswap/config.yaml`. Private; never published, never built.

## Layout

| File | What it is |
|---|---|
| `src/main.ts` | the CLI: probe → gate → select → download → render, with every side effect injected |
| `src/probe.ts` | the `Probe` contract, assembled from `prepare.sh`'s raw command output |
| `src/backend.ts`, `src/tier.ts` | backend and memory-tier selection, pure functions over a `Probe` |
| `src/manifest.ts` | `deploy/llm-appliance/models.json`, two models per tier |
| `src/download.ts` | `ensureModel`: one GGUF file into `<models>/<id>/<file>` |
| `src/env.ts`, `src/compose.ts`, `src/litellm.ts` | the rendered files |
| `src/logcheck.ts`, `src/verify-backend-cli.ts` | checks a `llama-server` log for the backend it was meant to use |
| `tests/fixtures/probe/`, `tests/snapshots/` | recorded probes and byte-for-byte expected outputs |

## How to run it

Operators do not run it directly. From `deploy/llm-appliance`:

```sh
./bin/prepare.sh            # probe, pick, download, render
./bin/prepare.sh --probe-only
```

`prepare.sh` collects raw command output on the host (`uname`, `/proc/meminfo`,
`nvidia-smi`, `lspci`, `/dev/dri`, …) without interpreting any of it, then runs
`src/main.ts` in a stock `node:22-alpine` container with the repository
bind-mounted:

```sh
node --experimental-strip-types apps/appliance-prepare/src/main.ts \
  --raw-probe /probe --appliance /work/deploy/llm-appliance [flags]
```

Flags: `--probe-only`, `--rotate-secrets`, `--skip-download`, `--llamaswap`,
`--models <path>`, `--backend <name>` (and the others listed in
`deploy/llm-appliance/README.md`, "Local models"). An unknown flag is an error
that names it. At the end it prints the exact `docker compose … up -d --wait`
command to run and writes `prepare-report.json`.

For development: `pnpm --filter @statewalker/httpeers-appliance-prepare test`.

## Why it is the way it is

### Standard library only, so the operator needs only Docker

The tool runs from source with `--experimental-strip-types` in a stock Node
container, with no `pnpm install`. So it imports nothing but `node:` builtins
(YAML is emitted as text), and `tests/boundary.test.ts` enforces that.

### Decisions are pure functions over a recorded probe

The shell script interprets nothing; everything downstream of `probe.json` is a
pure function. A probe recorded on a CUDA machine therefore drives the CUDA
path's tests on a machine with no GPU. CUDA and MUSA have no hardware in CI, so
their acceptance is the rendered output, compared byte-for-byte with
`tests/snapshots/`.

### Usable memory depends on the backend

A discrete NVIDIA or Moore Threads card's budget is its own VRAM. An integrated
GPU (Intel, AMD via Vulkan) and the CPU path borrow host RAM, so their budget is
host memory minus what the rest of the appliance needs. `tier.ts` picks the
tier from that number.

### Secrets in `.env` are preserved

Re-running `prepare.sh` is the normal way to pick up a new tier or backend, so
it keeps every secret already in `.env` unless `--rotate-secrets` is given. A
rotated `POSTGRES_PASSWORD` would orphan the existing Postgres volume (data
initialised with the old password), and the appliance would fail to start with
a cause that looks nothing like "prepare regenerated a password". The file is
written with mode `0600`. `HUB_DOOR_SECRET` is generated from `[A-Za-z0-9_-]`
only, because the proxy's entrypoint refuses to start on any other character.

## What will surprise you

- **A container asked for CUDA can silently run on the CPU.** It still starts,
  answers `/health` and serves requests if the device never attached, at a
  fraction of the speed. `logcheck.ts` (via `scripts/verify-backend.sh`) checks
  the `llama-server` log for the backend that actually initialised.
- **`docker compose` older than 2.24** is refused for the local-models pipeline
  (see `deploy/llm-appliance/README.md`).

## Reference

| Output (under `deploy/llm-appliance/`) | What it is |
|---|---|
| `probe.json` | the assembled probe |
| `.env` | appliance settings and secrets (mode 0600) |
| `compose.models.yml` | one `llama-server` service per model in the tier |
| `litellm/config.local.yaml` | LiteLLM's `model_list` for those services |
| `llamaswap/config.yaml` | only with `--llamaswap` |
| `prepare-report.json` | what was chosen and the `docker compose` command to run |
| `<models>/manifest.lock.json` | what was downloaded: repo, file, size, sha256, path |
