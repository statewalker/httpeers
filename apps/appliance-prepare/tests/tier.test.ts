import { describe, expect, it } from "vitest";
import { parseProbe } from "../src/probe.js";
import { chooseTier, usableMemoryBytes } from "../src/tier.js";

const GIB = 1024 ** 3;
const probeWith = (o: Record<string, unknown>) =>
  parseProbe(JSON.stringify({ schemaVersion: 1, ...o }));

describe("usableMemoryBytes", () => {
  it("uses the GPU's memory for cuda", () => {
    const probe = probeWith({
      nvidiaSmi: { gpus: [{ name: "X", memoryTotalMiB: 24564, driver: "1" }] },
    });
    const { bytes, basis } = usableMemoryBytes(probe, "cuda");
    expect(basis).toBe("gpu");
    expect(bytes).toBe(24564 * 1024 * 1024);
  });

  it("takes the LARGEST GPU when there are several", () => {
    const probe = probeWith({
      nvidiaSmi: {
        gpus: [
          { name: "A", memoryTotalMiB: 8192, driver: "1" },
          { name: "B", memoryTotalMiB: 24564, driver: "1" },
        ],
      },
    });
    expect(usableMemoryBytes(probe, "cuda").bytes).toBe(24564 * 1024 * 1024);
  });

  it("uses 60% of host RAM for an integrated GPU, which has no VRAM of its own", () => {
    const probe = probeWith({ memory: { totalBytes: 32 * GIB } });
    const { bytes, basis } = usableMemoryBytes(probe, "intel");
    expect(basis).toBe("host-ram");
    expect(bytes).toBeCloseTo(32 * GIB * 0.6, -6);
  });

  it("uses 60% of host RAM for cpu", () => {
    expect(usableMemoryBytes(probeWith({ memory: { totalBytes: 32 * GIB } }), "cpu").basis).toBe(
      "host-ram",
    );
  });
});

describe("chooseTier", () => {
  it.each([
    [4 * GIB, "small"],
    [15.9 * GIB, "small"],
    [16 * GIB, "medium"],
    [31 * GIB, "medium"],
    [32 * GIB, "large"],
    [80 * GIB, "large"],
  ])("maps %i usable bytes to %s", (usable, expected) => {
    const probe = probeWith({
      nvidiaSmi: { gpus: [{ name: "X", memoryTotalMiB: usable / (1024 * 1024), driver: "1" }] },
    });
    expect(chooseTier(probe, "cuda").tier).toBe(expected);
  });

  // Dedicated boundary assertions (in addition to the parametrised sweep
  // above): these pin the exact edges where a tier's real budget started
  // failing under the old 8/24 GiB bands (see the "Fix round 1" commit).
  it("sits just under 16 GiB in small, and at 16 GiB moves to medium", () => {
    const justUnder = probeWith({
      nvidiaSmi: {
        gpus: [{ name: "X", memoryTotalMiB: (16 * GIB - 1) / (1024 * 1024), driver: "1" }],
      },
    });
    const atBoundary = probeWith({
      nvidiaSmi: { gpus: [{ name: "X", memoryTotalMiB: (16 * GIB) / (1024 * 1024), driver: "1" }] },
    });
    expect(chooseTier(justUnder, "cuda").tier).toBe("small");
    expect(chooseTier(atBoundary, "cuda").tier).toBe("medium");
  });

  it("sits just under 32 GiB in medium, and at 32 GiB moves to large", () => {
    const justUnder = probeWith({
      nvidiaSmi: {
        gpus: [{ name: "X", memoryTotalMiB: (32 * GIB - 1) / (1024 * 1024), driver: "1" }],
      },
    });
    const atBoundary = probeWith({
      nvidiaSmi: { gpus: [{ name: "X", memoryTotalMiB: (32 * GIB) / (1024 * 1024), driver: "1" }] },
    });
    expect(chooseTier(justUnder, "cuda").tier).toBe("medium");
    expect(chooseTier(atBoundary, "cuda").tier).toBe("large");
  });

  it("falls to small when memory is unknown, and says why", () => {
    const choice = chooseTier(probeWith({}), "cpu");
    expect(choice.tier).toBe("small");
    expect(choice.reason).toMatch(/unknown/i);
  });

  it("honours an explicit override", () => {
    expect(chooseTier(probeWith({}), "cpu", "large").tier).toBe("large");
  });

  it("refuses an unknown override, naming the valid values", () => {
    expect(() => chooseTier(probeWith({}), "cpu", "huge")).toThrow(/huge.*small, medium, large/);
  });
});
