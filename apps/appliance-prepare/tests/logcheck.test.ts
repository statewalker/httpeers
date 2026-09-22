import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Backend } from "../src/backend.js";
import { backendRan } from "../src/logcheck.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/logs");

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, `${name}.log`), "utf8");
}

describe("backendRan", () => {
  it("accepts cpu unconditionally -- there is nothing to prove", () => {
    expect(backendRan("cpu", "").ok).toBe(true);
  });

  it("accepts cuda when the init line is there", () => {
    expect(backendRan("cuda", "ggml_cuda_init: found 1 CUDA devices\n").ok).toBe(true);
  });

  it("REJECTS cuda when llama.cpp silently ran on the CPU, and says exactly that", () => {
    const result = backendRan(
      "cuda",
      "llama_model_loader: loaded meta data\nload_tensors: CPU model buffer size = 4096 MiB\n",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cuda/);
    expect(result.reason).toMatch(/ggml_cuda_init/);
    expect(result.reason).toMatch(/CPU/i);
  });

  it("accepts vulkan, intel and musa on their own signatures", () => {
    expect(
      backendRan(
        "vulkan",
        "llama_prepare_model_devices: using device Vulkan0 (RADV NAVI31) - 24248 MiB free\n",
      ).ok,
    ).toBe(true);
    expect(
      backendRan(
        "intel",
        "llama_prepare_model_devices: using device SYCL0 (Intel(R) Iris(R) Xe Graphics)\n",
      ).ok,
    ).toBe(true);
    expect(backendRan("musa", "ggml_musa: using MUSA device 0\n").ok).toBe(true);
  });

  it("does not accept one GPU backend's signature as proof of another", () => {
    expect(
      backendRan("cuda", "llama_prepare_model_devices: using device Vulkan0 (RADV NAVI31)\n").ok,
    ).toBe(false);
  });

  it("accepts each backend against its own realistic, multi-line llama-server log", () => {
    const backends: Backend[] = ["cpu", "cuda", "vulkan", "intel", "musa"];
    for (const backend of backends) {
      const result = backendRan(backend, fixture(backend));
      expect(result.ok, `${backend}: ${result.reason}`).toBe(true);
    }
  });

  it("rejects a GPU backend against the cpu fixture, naming backend, signature and CPU", () => {
    const backends: Backend[] = ["cuda", "vulkan", "intel", "musa"];
    for (const backend of backends) {
      const result = backendRan(backend, fixture("cpu"));
      expect(result.ok, backend).toBe(false);
      expect(result.reason).toContain(backend);
      expect(result.reason).toMatch(/CPU/i);
    }
  });
});
