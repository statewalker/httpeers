import { describe, expect, it } from "vitest";
import { compareVersions, parseLspciDisplay, parseNvidiaSmiCsv, parseProbe } from "../src/probe.js";

describe("parseNvidiaSmiCsv", () => {
  it("reads name, memory and driver from the csv,noheader form", () => {
    const text = "NVIDIA GeForce RTX 4090, 24564 MiB, 560.35.03\n";
    expect(parseNvidiaSmiCsv(text)).toEqual([
      { name: "NVIDIA GeForce RTX 4090", memoryTotalMiB: 24564, driver: "560.35.03" },
    ]);
  });

  it("reads several GPUs", () => {
    const text = "A, 10 MiB, 1\nB, 20 MiB, 1\n";
    expect(parseNvidiaSmiCsv(text)).toHaveLength(2);
  });

  it("returns [] for empty or unparseable output rather than throwing", () => {
    expect(parseNvidiaSmiCsv("")).toEqual([]);
    expect(parseNvidiaSmiCsv("No devices were found\n")).toEqual([]);
  });
});

describe("parseLspciDisplay", () => {
  it("extracts the vendor and device id from the bracketed pair", () => {
    const line =
      "00:02.0 VGA compatible controller: Intel Corporation TigerLake-LP GT2 [Iris Xe Graphics] [8086:9a49] (rev 01)";
    expect(parseLspciDisplay(line)).toEqual([{ raw: line, vendorId: "8086", deviceId: "9a49" }]);
  });

  it("keeps the raw line when there is no id pair", () => {
    const line = "00:02.0 VGA compatible controller: Some Vendor Thing";
    expect(parseLspciDisplay(line)).toEqual([{ raw: line }]);
  });
});

describe("parseProbe", () => {
  it("refuses a schemaVersion it does not know, naming both versions", () => {
    expect(() => parseProbe(JSON.stringify({ schemaVersion: 99 }))).toThrow(
      /schemaVersion 99.*expected 1/,
    );
  });

  it("accepts a probe with nothing but the version, selecting nothing", () => {
    const probe = parseProbe(JSON.stringify({ schemaVersion: 1 }));
    expect(probe.pciDisplay).toEqual([]);
    expect(probe.nvidiaSmi).toBeNull();
    expect(probe.deviceNodes.dri).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("orders compose versions numerically, not lexically", () => {
    expect(compareVersions("2.35.1", "2.24.0")).toBeGreaterThan(0);
    expect(compareVersions("2.3.3", "2.24.0")).toBeLessThan(0);
    expect(compareVersions("5.5.1", "2.24.0")).toBeGreaterThan(0);
    expect(compareVersions("2.24.0", "2.24.0")).toBe(0);
  });
});
