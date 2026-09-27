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
 *
 * A tier's memory cost is NOT the size of its bigger model. Spec §3.5 runs
 * one `llama-server` per model, both resident at the same time, so the two
 * models in a tier are paid for together — see `tierBudget`. The band
 * floors (16 GiB, 32 GiB) were set to the sums that keep each tier's own
 * pair under its `minUsableBytes` in `models.json`, with margin; changing
 * either tier's models without re-checking `tierBudget` against
 * `minUsableBytes` can silently reopen the OOM-at-startup bug this file was
 * fixed for.
 */

import type { Backend } from "./backend.ts";
import type { ModelEntry } from "./manifest.ts";
import type { Probe } from "./probe.ts";

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
 * Maps usable memory to a tier: < 16 GiB is `small`, < 32 GiB is `medium`,
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

  if (bytes < 16 * GIB) {
    return {
      tier: "small",
      usableBytes: bytes,
      basis,
      reason: `Usable memory (${basis}) is below 16 GiB.`,
    };
  }
  if (bytes < 32 * GIB) {
    return {
      tier: "medium",
      usableBytes: bytes,
      basis,
      reason: `Usable memory (${basis}) is between 16 GiB and 32 GiB.`,
    };
  }
  return {
    tier: "large",
    usableBytes: bytes,
    basis,
    reason: `Usable memory (${basis}) is 32 GiB or more.`,
  };
}

// A resident llama-server process costs more than its GGUF file: the KV
// cache (sized by context length and model architecture) and the process's
// own overhead both add up. 0.5 GB flat plus 15% of the file size per model
// is the margin the spec's controller ruling settled on after the original
// "budget = larger file only" defect let a tier's two models be selected
// together but not actually fit together in memory.
const PER_MODEL_OVERHEAD_BYTES = 0.5e9;
const KV_CACHE_FRACTION = 0.15;

/**
 * The real memory cost of running a tier's models: spec §3.5 runs one
 * `llama-server` per model, ALL of a tier's models resident at once, so the
 * budget is the sum of every file plus each one's own overhead share — not
 * the size of the single largest file.
 */
export function tierBudget(models: ModelEntry[]): number {
  const totalFileSize = models.reduce((sum, model) => sum + model.fileSize, 0);
  return (
    totalFileSize + models.length * PER_MODEL_OVERHEAD_BYTES + KV_CACHE_FRACTION * totalFileSize
  );
}

/** Whether a tier's models fit under the usable memory a host reports. */
export function fitsTier(models: ModelEntry[], minUsableBytes: number): boolean {
  return tierBudget(models) <= minUsableBytes;
}
