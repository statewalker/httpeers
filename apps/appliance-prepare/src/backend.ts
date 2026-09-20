/**
 * Backend selection.
 *
 * `chooseBackend` is a pure function over a `Probe`: it never shells out and
 * never touches the filesystem, so the cuda and musa branches — for which no
 * hardware exists in CI or on the developer's machine — are exercised only
 * through recorded probe fixtures (see `tests/fixtures/probe/`). Keep it that
 * way; the moment this function reaches for `docker` or `/dev` directly, the
 * two branches become untestable except on borrowed hardware.
 *
 * The table below is binding (spec §5) and first-match-wins, in this exact
 * order: cuda, musa, intel, vulkan, cpu.
 */

import type { Probe } from "./probe.js";

export type Backend = "cpu" | "cuda" | "vulkan" | "intel" | "musa";

const BACKENDS: Backend[] = ["cpu", "cuda", "vulkan", "intel", "musa"];

function isBackend(value: string): value is Backend {
  return (BACKENDS as string[]).includes(value);
}

// These five tags were verified against the GHCR registry on 2026-09-20.
//
// There is no ROCm server image published by ggml-org/llama.cpp — an AMD
// card is driven through the generic `vulkan` build instead of a ROCm one.
// Do not go looking for `server-rocm`; it does not exist.
export const BACKEND_IMAGES: Record<Backend, string> = {
  cpu: "ghcr.io/ggml-org/llama.cpp:server",
  cuda: "ghcr.io/ggml-org/llama.cpp:server-cuda",
  vulkan: "ghcr.io/ggml-org/llama.cpp:server-vulkan",
  intel: "ghcr.io/ggml-org/llama.cpp:server-intel",
  musa: "ghcr.io/ggml-org/llama.cpp:server-musa",
};

export interface BackendChoice {
  backend: Backend;
  image: string;
  reason: string;
  warnings: string[];
}

function hasRenderNode(probe: Probe): boolean {
  return probe.deviceNodes.dri.some((node) => node.startsWith("renderD"));
}

function hasDisplayVendor(probe: Probe, vendorId: string): boolean {
  return probe.pciDisplay.some((entry) => entry.vendorId === vendorId);
}

function choose(backend: Backend, reason: string, warnings: string[] = []): BackendChoice {
  return { backend, image: BACKEND_IMAGES[backend], reason, warnings };
}

/**
 * Picks the llama.cpp server image to run for this host, or honours an
 * explicit `LLAMA_BACKEND` override that bypasses the table entirely.
 *
 * A GPU that is physically present but unusable by Docker (the
 * `nvidia-no-runtime` case) must never be dropped silently — that silence is
 * exactly the failure this function exists to prevent. It always carries a
 * warning naming the GPU and telling the operator how to fix it, attached to
 * whichever backend the rest of the table selects (ordinarily `cpu`, since a
 * real host with a discrete NVIDIA card rarely also has a Moore Threads or
 * integrated GPU — but the table is still walked in full instead of
 * special-casing this as an early return).
 */
export function chooseBackend(probe: Probe, override?: string): BackendChoice {
  if (override !== undefined) {
    if (!isBackend(override)) {
      throw new Error(
        `Unknown LLAMA_BACKEND override "${override}"; valid values are ${BACKENDS.join(", ")}`,
      );
    }
    return choose(
      override,
      `LLAMA_BACKEND=${override} was set explicitly, bypassing hardware detection.`,
    );
  }

  const hasNvidiaGpu = probe.nvidiaSmi !== null && probe.nvidiaSmi.gpus.length > 0;
  if (hasNvidiaGpu && probe.dockerRuntimes.includes("nvidia")) {
    return choose(
      "cuda",
      "nvidia-smi reported an NVIDIA GPU and Docker has the nvidia runtime installed.",
    );
  }

  // An NVIDIA GPU that Docker cannot see is only a *warning*, not an
  // immediate `cpu` result: the cuda rule simply didn't match, so the table
  // keeps walking musa, intel, vulkan before landing on cpu. Attach the
  // warning to whichever backend the rest of the table lands on — an earlier
  // version of this function returned `cpu` here directly, which silently
  // outranked musa/intel/vulkan and broke "first match wins" for any host
  // (however implausible) that also matched one of those rules.
  const nvidiaRuntimeWarnings: string[] = [];
  if (hasNvidiaGpu) {
    // nvidiaSmi is non-null here because hasNvidiaGpu is true.
    const gpuNames = (probe.nvidiaSmi?.gpus ?? []).map((gpu) => gpu.name).join(", ");
    nvidiaRuntimeWarnings.push(
      `NVIDIA GPU detected (${gpuNames}) but the Docker nvidia runtime is not installed. ` +
        "Install nvidia-container-toolkit and re-run this probe to enable the cuda backend.",
    );
  }

  if (probe.deviceNodes.mtgpu.length > 0) {
    return choose(
      "musa",
      "A Moore Threads GPU device node (/dev/mtgpu*) is present.",
      nvidiaRuntimeWarnings,
    );
  }

  if (hasRenderNode(probe) && hasDisplayVendor(probe, "8086")) {
    return choose(
      "intel",
      "A DRI render node and an Intel (vendor 8086) display controller are both present.",
      nvidiaRuntimeWarnings,
    );
  }

  if (hasRenderNode(probe) && hasDisplayVendor(probe, "1002")) {
    return choose(
      "vulkan",
      "A DRI render node and an AMD (vendor 1002) display controller are both present.",
      nvidiaRuntimeWarnings,
    );
  }

  if (hasNvidiaGpu) {
    return choose(
      "cpu",
      "An NVIDIA GPU was detected but Docker's nvidia runtime is not installed, so the cuda image would not be able to see it.",
      nvidiaRuntimeWarnings,
    );
  }

  return choose("cpu", "No usable GPU was detected, so the plain CPU image runs.");
}
