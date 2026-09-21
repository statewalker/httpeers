# N × llama-server vs. llama-swap — measured, not guessed

**Machine**: this workstation, same one BACKENDS.md measured — Intel Iris Xe (TigerLake-LP,
`8086:9a49`), `/dev/dri/{card1,renderD128}`, 31 GiB RAM (~10 GiB free at the time of this run), 8
cores. **Backend**: `vulkan` for both variants (same backend, same models, same prompt, as
required). **Tier**: `small` — `qwen2.5-1.5b-instruct` (1.1 GB) and `qwen2.5-3b-instruct` (2.1 GB),
already downloaded under `models/`. **Date**: 2026-09-21.

Both variants were brought up fresh (`docker compose down` first) so the timing numbers are
comparable. Latency was measured with `curl -w '%{time_starttransfer}'` against
`http://127.0.0.1:8081/peers/<hubPeerId>/llm/v1/chat/completions` (this run's `APPLIANCE_DOOR_PORT`
was 8081) through the LiteLLM master key, `"stream": true` (a non-streaming request's
`time_starttransfer` measures the whole completion, not the first token — verified the hard way,
see below), prompt *"Explain in one paragraph what a large language model is."*, `max_tokens: 128`.
Never a shell timing loop (Task 10's finding: it adds ~800 ms of its own overhead). Memory is a
single `docker stats --no-stream` snapshot, not an average.

## N × llama-server (today's default — three files)

```sh
docker compose -f compose.yml -f compose.local.yml -f compose.models.yml up -d --wait
```

| Measure | Value |
| --- | --- |
| Resident memory, idle, all 6 containers | **≈4.70 GiB** — hub 92.7 MiB, litellm 955.2 MiB, `llamacpp-qwen2.5-1.5b-instruct` 1.331 GiB, `llamacpp-qwen2.5-3b-instruct` 2.302 GiB, postgres 29.8 MiB, traefik 13.0 MiB |
| Time from `up` to both models answering | **41.3 s** (`up -d --wait` returns once every container, including both `llama-server`s, is healthy — both models are loaded at container start, in parallel, so "healthy" already means "answering") |
| First-token latency, model already resident (warm, n=3) | `qwen2.5-1.5b-instruct`: 68 / 68 / 66 ms. `qwen2.5-3b-instruct`: 108 / 126 / 111 ms |
| First-token latency, model **not** resident (the swap) | **N/A** — both models are always resident; there is no swap |
| Containers running | **6** — hub, postgres, litellm, traefik, `llamacpp-qwen2.5-1.5b-instruct`, `llamacpp-qwen2.5-3b-instruct` |

Cold (n=1, first request after `up`, empty prompt cache but model already resident):
`qwen2.5-1.5b-instruct` 74 ms, `qwen2.5-3b-instruct` 155 ms — barely different from warm, because
"cold" here still means "model already loaded", unlike llama-swap's cold below.

## llama-swap (alternative — four files, five services)

```sh
docker compose -f compose.yml -f compose.local.yml -f compose.models.yml -f compose.llamaswap.yml \
  up -d --wait hub postgres litellm traefik llamaswap
```

`compose.models.yml` is in the file list because `bin/prepare.sh` always writes it, `--llamaswap`
or not — it is harmless to *reference* (Compose only starts services actually named on the command
line, plus their dependencies), and naming exactly these five services is what keeps its
`llamacpp-<id>` services from starting alongside `llamaswap` and silently doubling the resident
model count. `bin/prepare.sh --llamaswap --backend vulkan --tier small` wrote `llamaswap/config.yaml`
and re-pointed every entry in `litellm/config.local.yaml` at `http://llamaswap:8080/v1` first (see
"Producing this state" below).

| Measure | Value |
| --- | --- |
| Resident memory, idle, all 5 containers, nothing loaded yet | **≈1.09 GiB** — hub 93.4 MiB, litellm 943.8 MiB, `llamaswap` 7.7 MiB (no model spawned), postgres 28.2 MiB, traefik 16.6 MiB |
| Resident memory, steady state, **one** model loaded | `qwen2.5-3b-instruct` resident: `llamaswap` 2.313 GiB, total **≈3.35 GiB**. `qwen2.5-1.5b-instruct` resident instead: `llamaswap` 1.361 GiB, total **≈2.40 GiB** |
| Time from `up` to both models answering | **≈65.2 s** — 43.0 s for the five containers to report healthy (at that point **no model is loaded**: llama-swap's own healthcheck only proves its HTTP server is up), **+22.3 s** more until each model has actually answered once (7.3 s for `qwen2.5-1.5b-instruct`'s first, cold load; 14.9 s for `qwen2.5-3b-instruct`'s, which also swaps the first one out) |
| First-token latency, model already resident (warm, n=3, `qwen2.5-3b-instruct` already loaded) | 85 / 82 / 126 ms — statistically indistinguishable from N × llama-server's own warm numbers above; llama-swap adds no measurable per-request overhead once a model is loaded |
| First-token latency, model **not** resident (the swap: unload the resident model, load the requested one), n=3, alternating | **1.46 s / 2.65 s / 1.48 s** (avg ≈1.86 s) — the real, unavoidable cost of this design, paid on every request for a model other than the one currently loaded |
| Containers running | **5** — hub, postgres, litellm, traefik, `llamaswap` |

### Producing this state

```sh
./bin/prepare.sh --skip-download --llamaswap --backend vulkan --tier small
docker compose -f compose.yml -f compose.local.yml -f compose.models.yml down
docker compose -f compose.yml -f compose.local.yml -f compose.models.yml -f compose.llamaswap.yml \
  up -d --wait hub postgres litellm traefik llamaswap
```

`--backend`/`--tier` are pinned explicitly on purpose: a bare `./bin/prepare.sh --llamaswap` re-probes
this machine from scratch and picked `intel`/`medium` here (31 GiB of host RAM puts it in the medium
tier, and `intel` outranks `vulkan` in `backend.ts`'s table) — a different backend AND a different,
not-yet-downloaded model pair (`qwen2.5-14b-instruct`) than the `vulkan`/`small` configuration this
benchmark (and the currently deployed appliance) actually runs. Passing both flags explicitly is
what keeps this comparison apples-to-apples; it is not `--llamaswap`-specific, the same footgun
exists for `bin/prepare.sh` with no flags at all on this particular host.

## e2e — `node e2e/e2e.mjs --local` against the llama-swap variant

**All six steps passed**, including the one this whole design exists to preserve:

```
PASS  1. Hub is up (14 ms)
PASS  2. Admin joins over the relay (isolated browser A), requests a key, chats (18334 ms)
      A: relay; first token 691 ms; reply in 1023 ms
PASS  3. Dashboard over the mesh (A's context): log in, renders, non-2xx listed (12486 ms)
PASS  4. Member B (isolated) is refused admin paths and chats with A's key (9711 ms)
PASS  5. Revocation: B's chat calls are refused as revoked after DELETE /hub/api/members/<B> (3401 ms)
      403-revoked 63 ms after the DELETE answered (attempt 1)
PASS  6. Host browser C joins as a member; link mode recorded (2292 ms)
PASS  cleanup. Deleted the 1 key(s) this run minted (33 ms)
e2e: all steps passed
```

**Revocation: 63 ms** — matches Task 12's 54–59 ms measurement of the same step against the
N × llama-server variant (well within run-to-run noise). Putting llama-swap behind LiteLLM changes
nothing about key minting or revocation, exactly as the design requires: LiteLLM is still the only
thing a member's key ever reaches, llama-swap never sees one. Full artifacts (screenshots,
`results.json`) are in `/tmp/llm-e2e-llamaswap` on this machine (not committed — see `E2E_ARTIFACTS`
in `e2e/README.md`).

## Caveats

One machine, one tier: everything above is `vulkan`, `small` tier, this host's 31 GiB / ~10 GiB
free. **The device wiring was measured on `vulkan` only.** `compose.llamaswap.yml` mounts
`/dev/dri` unconditionally; it was never brought up, and would not come up as written, on a `cuda`
or `musa` host (no such hardware exists anywhere in this project — see `BACKENDS.md`). A GPU
comparison on those backends would need that file's device list adjusted first, and is a fresh
measurement, not an extrapolation from this one.

## Recommendation: **stay on N × llama-server for this appliance today**

At the `small` tier, the two models' combined resident footprint is 1.1 + 2.1 = 3.2 GB of model
weight (≈3.6 GiB of container RSS measured above) — comfortably inside this host's ~10 GiB free and
31 GiB total. Memory is simply not the binding constraint this deployment is running into, so
llama-swap's entire value proposition (fit into less RAM by keeping one model resident instead of
N) does not have a problem to solve here yet. What it costs instead is real and immediate: every
request for a model other than the one currently loaded pays a **1.5–2.6 s** stall (avg ≈1.86 s,
measured above) — and this appliance is a **multi-member mesh hub**, not a single-user tool. Once
two members are using different models around the same time (a completely ordinary case, not an
edge case), llama-swap does not settle into one steady state — it thrashes, and *every* member pays
that stall on *every* request that lands after someone else's request for the other model. N ×
llama-server gives every member the same ~65–125 ms warm latency regardless of which model they
pick, unconditionally.

**Keep `README.md` pointing operators at the three-file, N × llama-server invocation as the
default.** `compose.llamaswap.yml` stays as a documented, tested alternative — worth reconsidering
specifically for the `medium` and `large` tiers, where a single resident model can be 9–20 GB
(`qwen2.5-14b-instruct` at 9.0 GB, `qwen2.5-32b-instruct` at 19.9 GB) and doubling that up really
would strain a host's memory, which is the scenario this design was actually built for — just not
the one this appliance runs today. If this appliance is ever moved to a `medium`/`large` tier host,
or to a host with materially less free RAM than this one, re-run this benchmark there before
deciding again; nothing here says llama-swap is bad, only that it is not yet the better trade **on
this host, at this tier**.

## Appliance state at hand-off

Left running on **N × llama-server, `vulkan`, `small` tier** (the recommendation above) —
`./bin/prepare.sh --skip-download --backend vulkan --tier small` restored `litellm/config.local.yaml`
to routing each model at its own `llamacpp-<id>` service, then
`docker compose -f compose.yml -f compose.local.yml -f compose.models.yml up -d --wait`.
`scripts/health.sh`: **12/12 PASS**. Traefik on `127.0.0.1:8081` (`APPLIANCE_DOOR_PORT` from
`.env`). The user's own SSH tunnel on `127.0.0.1:8080` (PID 440045) was never touched.
