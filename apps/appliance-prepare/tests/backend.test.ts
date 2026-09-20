import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKEND_IMAGES, chooseBackend } from "../src/backend.js";
import { parseProbe } from "../src/probe.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/probe");
const load = async (name: string) =>
  parseProbe(await readFile(resolve(FIXTURES, `${name}.json`), "utf8"));

describe("chooseBackend", () => {
  it("picks cuda when there is an NVIDIA GPU and Docker has the nvidia runtime", async () => {
    const choice = chooseBackend(await load("nvidia-with-runtime"));
    expect(choice.backend).toBe("cuda");
    expect(choice.image).toBe(BACKEND_IMAGES.cuda);
  });

  it("falls back to cpu when an NVIDIA GPU has no nvidia runtime, and SAYS SO", async () => {
    const choice = chooseBackend(await load("nvidia-no-runtime"));
    expect(choice.backend).toBe("cpu");
    expect(choice.warnings.join(" ")).toMatch(/NVIDIA/);
    expect(choice.warnings.join(" ")).toMatch(/nvidia-container-toolkit/);
  });

  it("picks musa when an mtgpu device node is present", async () => {
    expect((await load("musa").then((p) => chooseBackend(p))).backend).toBe("musa");
  });

  it("picks intel for an 8086 display device with a render node", async () => {
    expect((await load("intel-igpu").then((p) => chooseBackend(p))).backend).toBe("intel");
  });

  it("picks vulkan for a 1002 (AMD) display device with a render node", async () => {
    expect((await load("amd-vulkan").then((p) => chooseBackend(p))).backend).toBe("vulkan");
  });

  it("picks cpu when there is no GPU at all", async () => {
    expect((await load("cpu-only").then((p) => chooseBackend(p))).backend).toBe("cpu");
  });

  it("picks cpu from a probe that carries nothing but its version", async () => {
    expect((await load("minimal").then((p) => chooseBackend(p))).backend).toBe("cpu");
  });

  it("always explains itself", async () => {
    for (const name of ["cpu-only", "intel-igpu", "nvidia-with-runtime", "musa", "amd-vulkan"]) {
      const choice = chooseBackend(await load(name));
      expect(choice.reason.length).toBeGreaterThan(20);
    }
  });

  it("honours an explicit override", async () => {
    const choice = chooseBackend(await load("cpu-only"), "cuda");
    expect(choice.backend).toBe("cuda");
    expect(choice.reason).toMatch(/LLAMA_BACKEND/);
  });

  it("refuses an unknown override, naming it and the valid values", async () => {
    const probe = await load("cpu-only");
    expect(() => chooseBackend(probe, "rocm")).toThrow(/rocm/);
    expect(() => chooseBackend(probe, "rocm")).toThrow(/cpu, cuda, vulkan, intel, musa/);
  });

  // Every fixture above matches exactly one rule in the table, so none of the
  // tests above would fail if the table's order were shuffled — they prove
  // each rule fires, not that it outranks the others. `multi-gpu` is a
  // physically implausible probe that satisfies all four GPU rules (cuda,
  // musa, intel, vulkan) simultaneously; deriving cpu/mtgpu/runtime variants
  // from it by spreading is the only way to pin "first match wins" down to a
  // test that would actually fail if the order in src/backend.ts changed.
  describe("rule ordering (first match wins)", () => {
    it("cuda outranks musa, intel and vulkan when a machine somehow matches all four", async () => {
      const probe = await load("multi-gpu");
      expect(chooseBackend(probe).backend).toBe("cuda");
    });

    it("musa outranks intel and vulkan once the nvidia runtime is unavailable", async () => {
      const probe = await load("multi-gpu");
      const withoutNvidiaRuntime = { ...probe, dockerRuntimes: ["runc"] };
      expect(chooseBackend(withoutNvidiaRuntime).backend).toBe("musa");
    });

    it("intel outranks vulkan once neither nvidia runtime nor mtgpu node remain", async () => {
      const probe = await load("multi-gpu");
      const gpuOnlyRenderNode = {
        ...probe,
        dockerRuntimes: ["runc"],
        deviceNodes: { ...probe.deviceNodes, mtgpu: [] },
      };
      expect(chooseBackend(gpuOnlyRenderNode).backend).toBe("intel");
    });
  });
});
