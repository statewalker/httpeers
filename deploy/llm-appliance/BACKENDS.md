# Backend status: what actually ran here, and what only rendered

This appliance supports five llama.cpp backends. On this machine (Intel Iris Xe / TigerLake-LP,
`8086:9a49`, `/dev/dri/{card1,renderD128}`, no NVIDIA) **three of the five were actually brought up
and exercised: `cpu`, `intel`, `vulkan`.** Both genuinely ran real inference on real hardware
through the whole door → hub → LiteLLM → llama-server chain, not just `docker compose config`.

**`cuda` and `musa` have never been executed, anywhere, in this project.** No NVIDIA GPU and no
Moore Threads GPU exist on any machine this project has had access to. Their entire acceptance bar
is `apps/appliance-prepare`'s unit tests: `compose.ts`'s output is asserted byte-for-byte against a
checked-in snapshot, and `backend.ts`'s selection logic is exercised only against recorded probe
JSON fixtures (`nvidia-with-runtime.json` for cuda, `musa.json` for musa) — never against a live
probe of real hardware. Nothing in this table's `cuda`/`musa` rows should be read as "this was
tried and it worked". It means "this was rendered, and never run".

In particular, **the MUSA device-node list is a guess**: `compose.ts`'s `devicesFor("musa")`
mounts `/dev/mtgpu` (plus `/dev/dri`, since MUSA GPUs also expose a DRI render node) because that
is the device path Moore Threads' own driver documentation names, not because it was ever checked
against a real Moore Threads card. If that path is wrong, `musa`'s `compose.models.yml` output will
still render, `docker compose config` will still validate it, and the container will still start —
it just won't see a GPU, and nothing before `scripts/verify-backend.sh` runs would tell you.

**This is not a symmetric "unverified either way" situation — read the base rate.** Of the two
backend signatures this project *could* check against real hardware, `intel` and `vulkan`, **both**
turned out wrong (see the next section): the spec-era placeholders (`ggml_sycl`, `ggml_vulkan:`)
appear nowhere in build 11058's actual output, at any verbosity. `cuda`'s `ggml_cuda_init` and
`musa`'s `ggml_musa` signatures come from that exact same spec-era guessing process, unchecked
against anything real, with a demonstrated 0-for-2 track record on the two guesses that *were*
checkable. They should be read as **likely wrong**, not merely "unproven" — treat a `cuda`/`musa`
bring-up's first `verify-backend.sh` failure as the expected outcome, not a surprise, and re-derive
the signature from a real captured log the same way this task did for `intel`/`vulkan`, rather than
assuming the recorded one just needs debugging around.

**`scripts/verify-backend.sh` is the thing that closes that gap.** `docker compose config` proves
the *configuration* asked for a GPU (right image, right device mount). It cannot prove llama.cpp
actually found and used one — a container asking for `server-cuda`, `server-musa`, `server-intel`
or `server-vulkan` still starts, still answers `/health`, and still serves requests even if the
device never attached; it just silently falls back to the CPU and runs at a fraction of the speed,
with nothing in `docker compose ps` to say so. `verify-backend.sh` greps the real
`docker compose logs` output for a backend-specific signature line (`src/logcheck.ts`,
`BACKEND_SIGNATURES`) and fails loudly, naming the backend, if that signature never appears. This
is the check an operator (or `cuda`/`musa`'s first real deploy, whenever that happens) must run and
trust before believing a GPU backend claim.

## A signature bug this task found and fixed — do not skip this if you're touching `logcheck.ts`

`BACKEND_SIGNATURES.intel` (`"ggml_sycl"`) and `.vulkan` (`"ggml_vulkan:"`) were spec-era
placeholders, written before either backend had ever run on real hardware. They do not match. The
`intel` bring-up below initially **failed** `verify-backend.sh` even though the GPU log evidence
(re-run at `--verbosity 4`, see below) showed llama.cpp genuinely selecting `SYCL0` and offloading
29/29 layers to it. The literal strings `ggml_sycl` and `ggml_vulkan:` do not appear anywhere in
`ghcr.io/ggml-org/llama.cpp:server-intel`/`:server-vulkan` (build 11058) output, at any verbosity up
to `-lv 99` — confirmed by grep against the full log. That build's SYCL/Vulkan backends log through
a different, device-name-keyed format instead (`llama_prepare_model_devices: using device SYCL0
...` / `... using device Vulkan0 ...`).

A second, independent problem stacked on top of it: at llama-server's **default** verbosity (3),
none of this — not the old signature, not the new one, not even the device's name — is logged at
all. `verify-backend.sh` could not have passed or failed *correctly* on a GPU backend at the
compose-generated default; it would just find an empty log every time. Both are now fixed in
`apps/appliance-prepare/src/`:

- `compose.ts` adds `--verbosity 4` to every GPU backend's `llama-server` command (not `cpu`, which
  has nothing to prove) — the minimum verbosity that emits `device_info:`,
  `llama_prepare_model_devices: using device ...` and `load_tensors: offloaded N/N layers to GPU`,
  without the per-layer/per-token debug flood `-lv 99` turns on.
- `logcheck.ts`'s `BACKEND_SIGNATURES.intel`/`.vulkan` are now `"using device SYCL0"` /
  `"using device Vulkan0"` — the real, verified-on-hardware signature. `cuda` and `musa` are
  **untouched**: there is no hardware here to check their old signatures against, so changing them
  now would be exactly the "weaken the check to force a pass" move this task was told not to make.
  If `cuda`/`musa` ever get a real bring-up, check their signatures the same way this task checked
  `intel`/`vulkan`'s, don't assume they're right.

Unit tests, fixtures (`tests/fixtures/logs/{intel,vulkan}.log`, now rewritten to real captured
log text rather than the old hand-written build-3950 guesses) and snapshots
(`tests/snapshots/compose-{cuda,vulkan,intel,musa}.yml`) were updated to match. `pnpm --filter
@statewalker/httpeers-appliance-prepare exec vitest run`: 120/120 passing, `tsc --noEmit` clean,
`biome check src tests` clean.

## The table

| Backend | Image | Status | Evidence |
| --- | --- | --- | --- |
| `cpu` | `ghcr.io/ggml-org/llama.cpp:server` | **Executed** | Task 10, this machine, 2026-09-20. `verify-backend.sh`: PASS (no signature to prove). TTFB (curl `time_starttransfer`, `Say OK`): warm 61–126 ms (n=3), one cold-cache sample 1.64 s. |
| `intel` | `ghcr.io/ggml-org/llama.cpp:server-intel` | **Executed** | Task 11, 2026-09-21, Intel Iris Xe (TigerLake-LP, `8086:9a49`) via `/dev/dri`. `verify-backend.sh`: **PASS** — `found "using device SYCL0" -- intel initialised its device"`, both `llamacpp-qwen2-5-1-5b-instruct` and `llamacpp-qwen2-5-3b-instruct`. Log (`--verbosity 4`): `llama_prepare_model_devices: using device SYCL0 (Intel(R) Iris(R) Xe Graphics) (unknown id) - 9227 MiB free`, `load_tensors: offloaded 29/29 layers to GPU`, `SYCL0 model buffer size = 934.70 MiB`. TTFT/TPS below. |
| `vulkan` | `ghcr.io/ggml-org/llama.cpp:server-vulkan` | **Executed** | Task 11, 2026-09-21, same Iris Xe via the generic Vulkan path (`/dev/dri`). `verify-backend.sh`: **PASS** — `found "using device Vulkan0" -- vulkan initialised its device"`, both services. Log (`--verbosity 4`): `llama_prepare_model_devices: using device Vulkan0 (Intel(R) Iris(R) Xe Graphics (TGL GT2)) (0000:00:02.0) - 14120 MiB free`, `load_tensors: offloaded 29/29 layers to GPU`, `Vulkan0 model buffer size = 934.69 MiB`. TTFT/TPS below. |
| `cuda` | `ghcr.io/ggml-org/llama.cpp:server-cuda` | **Rendered only — never executed** | `compose config` passes; `compose-cuda.yml` snapshot asserted byte-for-byte; selection driven from `tests/fixtures/probe/nvidia-with-runtime.json`, a recorded fixture, not a live probe. **No NVIDIA hardware has ever been available to this project.** |
| `musa` | `ghcr.io/ggml-org/llama.cpp:server-musa` | **Rendered only — never executed** | As above, driven from `tests/fixtures/probe/musa.json`. **The `/dev/mtgpu` device-node path is an unverified guess** — see above. |

## Measurements: TTFT and tokens/sec, `qwen2.5-1.5b-instruct`, through the door (`127.0.0.1:8081`)

Fixed prompt for `intel`/`vulkan` (chosen to produce enough output tokens for a meaningful tok/s
number, unlike Task 10's one-word `Say OK`): *"Explain in one paragraph what a large language model
is."*, `max_tokens: 128`, `"stream": true`. Measured with `curl -w '%{time_starttransfer}'` against
`http://127.0.0.1:8081/peers/<hub-peer-id>/llm/v1/chat/completions` through a freshly minted
LiteLLM key (never a shell timing loop — Task 10 found a bash loop adds ~800 ms of its own
overhead). Tokens/sec is llama.cpp's own `timings.predicted_per_second` from the final SSE chunk,
not counted client-side. "Cold" = first completion request after the backend's containers came up
(prompt cache empty, `cache_n: 0`); "warm" = subsequent requests against the same running server
(prompt cache hit, `cache_n: 40`, only the new turn is actually processed).

| Backend | Cold TTFT (n=1) | Warm TTFT (n=3) | Warm tokens/sec (n=3) |
| --- | --- | --- | --- |
| `cpu` (Task 10, `Say OK`, not directly comparable — see below) | 1.64 s | 61 ms / 68 ms / 126 ms | not measurable (3-token replies) |
| `intel` | 3.80 s | 65 ms / 76 ms / 95 ms | 15.4 / 19.4 / 20.0 |
| `vulkan` | 0.59 s | 48 ms / 71 ms / 71 ms | 22.9 / 24.0 / 33.1 |

`cpu`'s row is reused from Task 10's report as instructed (this task did not re-run `cpu`); it used
a different, one-word prompt (`Say OK`, 3 predicted tokens) that cannot produce a meaningful
tokens/sec figure, so it is not apples-to-apples with `intel`/`vulkan`'s longer, fixed prompt. It is
included only for rough perspective — the *shape* (cache hit vs. miss dominates TTFT) matches what
`intel`/`vulkan` also show.

On this Iris Xe, `intel` (SYCL) had a **much slower cold start** than `vulkan` despite model load
itself finishing well before the first request (both backends' `llama_server: model loaded` logs at
~1.2–2.1 s in) — the extra ~3 s on `intel`'s first token is consistent with SYCL/Level-Zero kernel
JIT compilation happening on first dispatch, something Vulkan's precompiled SPIR-V path does not
pay. Warm-state, `vulkan` was also consistently faster (23–33 tok/s vs. `intel`'s 15–20 tok/s) in
this run. Neither figure should be read as a general SYCL-vs-Vulkan verdict — one machine, one
model, one run each — only as what was actually observed here.

## Appliance state at hand-off

Left running on **`vulkan`** (both backends verified genuinely; vulkan was chosen over intel for
its faster cold start and higher warm throughput on this hardware, observed above).
`scripts/health.sh`: 12/12 PASS. `docker compose ps`: all six services healthy, Traefik on
`127.0.0.1:8081`. The user's own SSH tunnel on `127.0.0.1:8080` was never touched.
