/**
 * Memory tier selection.
 *
 * "Usable memory" is not the same number for every backend: a discrete
 * NVIDIA/Moore Threads card carries its own VRAM, so the model budget is the
 * card's memory, full stop. An integrated GPU (Intel, AMD via Vulkan) and the
 * plain CPU path have no VRAM of their own — they borrow host RAM, and the
 * appliance must leave the host some room to keep running (Docker daemon,
 * the OS, the other compose services), hence the 60% cap rather than 100%.
 *
 * Tiers then bucket that usable-memory number into a model size class. The
 * bands are deliberately conservative at the low end: unknown memory maps to
 * `small`, because guessing high means the chosen model doesn't fit and the
 * appliance fails to start, while guessing low only means it runs a more
 * modest model than the hardware could have handled.
 */

import type { Backend } from "./backend.js";
import type { Probe } from "./probe.js";

export type Tier = "small" | "medium" | "large";

export interface TierChoice {
  tier: Tier;
  usableBytes: number;
  basis: "gpu" | "host-ram";
  reason: string;
}

const TIERS: Tier[] = ["small", "medium", "large"];

function isTier(value: string): value is Tier {
  return (TIERS as string[]).includes(value);
}

// Backends that carry their own dedicated VRAM: the usable budget is that
// card's memory, not a fraction of host RAM.
const GPU_MEMORY_BACKENDS: readonly Backend[] = ["cuda", "musa"];

// The host keeps 40% of its RAM for itself; the model budget is the rest.
const HOST_RAM_FRACTION = 0.6;

const GIB = 1024 ** 3;

/**
 * Computes how much memory is actually available to run a model on this
 * host with the given backend. For `cuda`/`musa` that is the largest GPU's
 * VRAM (a multi-GPU host is not assumed to pool memory across cards, so only
 * the biggest single card counts). For every other backend it is a fraction
 * of host RAM, because an integrated GPU or the CPU path has no VRAM of its
 * own to report.
 */
export function usableMemoryBytes(
  probe: Probe,
  backend: Backend,
): { bytes: number; basis: "gpu" | "host-ram" } {
  if (GPU_MEMORY_BACKENDS.includes(backend)) {
    const gpus = probe.nvidiaSmi?.gpus ?? [];
    const largestMiB = gpus.reduce((max, gpu) => Math.max(max, gpu.memoryTotalMiB), 0);
    return { bytes: largestMiB * 1024 * 1024, basis: "gpu" };
  }
  const totalBytes = probe.memory.totalBytes ?? 0;
  return { bytes: totalBytes * HOST_RAM_FRACTION, basis: "host-ram" };
}

/**
 * Maps usable memory to a tier: < 8 GiB is `small`, < 24 GiB is `medium`,
 * everything else is `large`. `override` (the `LLAMA_TIER` env var) bypasses
 * detection entirely and must be one of the three tier names, or this
 * throws naming both the bad value and the valid set — an unrecognised
 * override silently falling back to detection would hide the operator's
 * typo instead of surfacing it.
 */
export function chooseTier(probe: Probe, backend: Backend, override?: string): TierChoice {
  if (override !== undefined) {
    if (!isTier(override)) {
      throw new Error(
        `Unknown LLAMA_TIER override "${override}"; valid values are ${TIERS.join(", ")}`,
      );
    }
    const { bytes, basis } = usableMemoryBytes(probe, backend);
    return {
      tier: override,
      usableBytes: bytes,
      basis,
      reason: `LLAMA_TIER=${override} was set explicitly, bypassing memory detection.`,
    };
  }

  const { bytes, basis } = usableMemoryBytes(probe, backend);

  if (bytes <= 0) {
    return {
      tier: "small",
      usableBytes: bytes,
      basis,
      reason:
        "Usable memory is unknown (the probe reported no figure), so the smallest tier was chosen defensively.",
    };
  }

  if (bytes < 8 * GIB) {
    return {
      tier: "small",
      usableBytes: bytes,
      basis,
      reason: `Usable memory (${basis}) is below 8 GiB.`,
    };
  }
  if (bytes < 24 * GIB) {
    return {
      tier: "medium",
      usableBytes: bytes,
      basis,
      reason: `Usable memory (${basis}) is between 8 GiB and 24 GiB.`,
    };
  }
  return {
    tier: "large",
    usableBytes: bytes,
    basis,
    reason: `Usable memory (${basis}) is 24 GiB or more.`,
  };
}
