/**
 * The runtime half of spec §3.4: `docker compose config` proves the Compose
 * file selected the right image and device mapping. It cannot prove
 * llama.cpp actually initialised the GPU backend -- a container that asked
 * for `server-cuda` still starts, still answers `/health`, and still serves
 * requests if the CUDA device never attached; it just silently falls back to
 * the CPU and runs at a fraction of the speed. `backendRan` closes that gap
 * by grepping the one line each backend logs on successful device init (see
 * `BACKEND_SIGNATURES`, spec §9 -- binding).
 *
 * `cpu` has no signature: there is nothing to prove, so it always passes.
 * Every GPU backend's signature is distinct and checked exactly -- one
 * backend's signature is never accepted as proof of another (a `cuda`
 * container whose log only shows `using device Vulkan0` did NOT run on
 * CUDA).
 *
 * `intel` and `vulkan`'s signatures were corrected during Task 11's real
 * bring-up on an Intel Iris Xe: the `ggml_sycl`/`ggml_vulkan:` strings this
 * table shipped with (spec-era placeholders, never run against real
 * hardware) do not appear anywhere in `ghcr.io/ggml-org/llama.cpp:server-
 * intel`/`:server-vulkan` (build 11058) output, at any verbosity -- that
 * build's SYCL/Vulkan backends log through a different, device-name-keyed
 * format (`llama_prepare_model_devices: using device SYCL0 ...` /
 * `... using device Vulkan0 ...`), with no `ggml_sycl`/`ggml_vulkan:`
 * substring anywhere in the output. Confirmed genuine (not a logging
 * fluke) by cross-checking the same run's `load_tensors: offloaded N/N
 * layers to GPU` line and non-zero `SYCL0`/`Vulkan0 model buffer size` --
 * see `deploy/llm-appliance/BACKENDS.md`. `cuda` and `musa`'s signatures
 * are untouched: no hardware here to check them against.
 */

import type { Backend } from "./backend.ts";

export const BACKEND_SIGNATURES: Record<Backend, string | null> = {
  cpu: null,
  cuda: "ggml_cuda_init",
  vulkan: "using device Vulkan0",
  intel: "using device SYCL0",
  musa: "ggml_musa",
};

/**
 * Checks whether `logText` (the container's `docker compose logs` output)
 * proves `backend` actually ran. `cpu` always passes. Every other backend
 * requires its own signature, verbatim, to appear somewhere in the log --
 * on failure, the reason names the backend, the signature that was looked
 * for, and that the appliance is running on CPU regardless.
 */
export function backendRan(backend: Backend, logText: string): { ok: boolean; reason: string } {
  const signature = BACKEND_SIGNATURES[backend];
  if (signature === null) {
    return { ok: true, reason: "cpu has no device signature to prove" };
  }
  if (logText.includes(signature)) {
    return { ok: true, reason: `found "${signature}" -- ${backend} initialised its device` };
  }
  return {
    ok: false,
    reason:
      `backend "${backend}" was selected but its signature "${signature}" was not found in the log -- ` +
      `the appliance is running on CPU despite selecting ${backend} -- check the device wiring in ` +
      "compose.models.yml and the host driver",
  };
}
