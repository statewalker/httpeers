import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseManifest, serviceNameOf } from "../src/manifest.js";
import { tierBudget } from "../src/tier.js";

describe("parseManifest", () => {
  it("refuses an id that is not a legal Compose service name, naming it", () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      tiers: {
        small: [{ id: "Qwen_2.5", repo: "r", file: "f", ctx: 4096 }],
        medium: [],
        large: [],
      },
    });
    expect(() => parseManifest(bad)).toThrow(/Qwen_2\.5/);
  });

  it("turns a dotted id into a dashed service name", () => {
    expect(serviceNameOf("qwen2.5-1.5b-instruct")).toBe("llamacpp-qwen2-5-1-5b-instruct");
  });

  it("refuses two models sharing an id", () => {
    const dup = JSON.stringify({
      schemaVersion: 1,
      tiers: {
        small: [
          { id: "a", repo: "r", file: "f", ctx: 1 },
          { id: "a", repo: "r2", file: "f2", ctx: 1 },
        ],
        medium: [],
        large: [],
      },
    });
    expect(() => parseManifest(dup)).toThrow(/duplicate.*"a"/i);
  });
});

describe("the checked-in models.json", () => {
  it("parses, and gives every tier exactly two models", async () => {
    const manifest = parseManifest(
      await readFile("../../deploy/llm-appliance/models.json", "utf8"),
    );
    for (const tier of ["small", "medium", "large"] as const) {
      expect(manifest.tiers[tier]).toHaveLength(2);
    }
  });

  // This is the test that would have caught the original defect: a tier
  // whose two models are individually plausible can still not fit together,
  // because spec §3.5 runs both `llama-server` processes at once. It reads
  // the real checked-in file, not a fixture, so a future edit to
  // models.json that reopens the gap fails CI here instead of at an
  // operator's OOM on startup.
  it("keeps every tier's real budget under its own minUsableBytes", async () => {
    const manifest = parseManifest(
      await readFile("../../deploy/llm-appliance/models.json", "utf8"),
    );
    for (const tier of ["small", "medium", "large"] as const) {
      expect(tierBudget(manifest.tiers[tier])).toBeLessThanOrEqual(manifest.minUsableBytes[tier]);
    }
  });
});
