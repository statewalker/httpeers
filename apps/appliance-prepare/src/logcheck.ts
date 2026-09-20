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
 * container whose log only shows `ggml_vulkan:` did NOT run on CUDA).
 */

import type { Backend } from "./backend.ts";

export const BACKEND_SIGNATURES: Record<Backend, string | null> = {
  cpu: null,
  cuda: "ggml_cuda_init",
  vulkan: "ggml_vulkan:",
  intel: "ggml_sycl",
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
