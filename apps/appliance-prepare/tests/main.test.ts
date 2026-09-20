import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Io } from "../src/main.js";
import { assembleProbe, composeCommand, parseArgs, run } from "../src/main.js";
import { serviceNameOf } from "../src/manifest.js";

describe("parseArgs", () => {
  it("defaults to a full run", () => {
    const args = parseArgs(["--appliance", "/work/deploy/llm-appliance"]);
    expect(args.probeOnly).toBe(false);
    expect(args.rotateSecrets).toBe(false);
  });

  it("refuses an unknown flag, naming it", () => {
    expect(() => parseArgs(["--appliance", "/a", "--wat"])).toThrow(/--wat/);
  });

  it("requires --appliance", () => {
    expect(() => parseArgs([])).toThrow(/--appliance/);
  });

  it("parses every flag", () => {
    const args = parseArgs([
      "--raw-probe",
      "/probe",
      "--appliance",
      "/a",
      "--probe-only",
      "--rotate-secrets",
      "--skip-download",
      "--models",
      "/other/models.json",
      "--backend",
      "cpu",
      "--tier",
      "small",
    ]);
    expect(args).toEqual({
      rawProbe: "/probe",
      appliance: "/a",
      probeOnly: true,
      rotateSecrets: true,
      skipDownload: true,
      models: "/other/models.json",
      backend: "cpu",
      tier: "small",
    });
  });
});

describe("assembleProbe", () => {
  it("builds a valid probe from raw files, tolerating every one being absent", () => {
    const probe = assembleProbe("/probe", () => null);
    expect(probe.schemaVersion).toBe(1);
    expect(probe.pciDisplay).toEqual([]);
  });

  it("puts a GPU name containing a quote into JSON without breaking it", () => {
    const raw: Record<string, string> = { "nvidia-smi": 'NVIDIA "Quoted" GPU, 100 MiB, 1' };
    const probe = assembleProbe("/probe", (n) => raw[n] ?? null);
    expect(probe.nvidiaSmi?.gpus[0].name).toBe('NVIDIA "Quoted" GPU');
  });

  it("assembles every field from the raw probe files bin/prepare.sh writes", () => {
    const raw: Record<string, string> = {
      kernel: "Linux\n",
      arch: "x86_64\n",
      "os-pretty-name": 'PRETTY_NAME="Ubuntu 24.04.4 LTS"\n',
      "cpu-cores": "8\n",
      "mem-total": "MemTotal:       33270484 kB\n",
      "docker-engine": "28.1.1\n",
      "docker-compose": "2.35.1\n",
      "docker-runtimes": '{"io.containerd.runc.v2":{},"runc":{}}\n',
      "lspci-display":
        "00:02.0 VGA compatible controller: Intel Corporation [Iris Xe Graphics] [8086:9a49] (rev 01)\n",
      "dev-dri": "card1\nrenderD128\n",
      "dev-mtgpu": "",
      "kfd-exit": "1",
    };
    const probe = assembleProbe("/probe", (n) => raw[n] ?? null);
    expect(probe.os).toEqual({ kernel: "Linux", arch: "x86_64", prettyName: "Ubuntu 24.04.4 LTS" });
    expect(probe.cpu.cores).toBe(8);
    expect(probe.memory.totalBytes).toBe(33270484 * 1024);
    expect(probe.docker).toEqual({ engine: "28.1.1", compose: "2.35.1" });
    expect(probe.dockerRuntimes.sort()).toEqual(["io.containerd.runc.v2", "runc"]);
    expect(probe.pciDisplay).toEqual([
      {
        raw: "00:02.0 VGA compatible controller: Intel Corporation [Iris Xe Graphics] [8086:9a49] (rev 01)",
        vendorId: "8086",
        deviceId: "9a49",
      },
    ]);
    expect(probe.deviceNodes).toEqual({ dri: ["card1", "renderD128"], mtgpu: [], kfd: false });
    expect(probe.nvidiaSmi).toBeNull();
  });
});

describe("composeCommand", () => {
  it("names all three files in the order compose must read them", () => {
    expect(composeCommand()).toBe(
      "docker compose -f compose.yml -f compose.local.yml -f compose.models.yml up -d --wait",
    );
  });
});

// --- run() -----------------------------------------------------------

const MODELS_JSON = JSON.stringify({
  schemaVersion: 1,
  minUsableBytes: {
    small: 5368709120,
    medium: 17179869184,
    large: 34359738368,
  },
  tiers: {
    // Realistic file sizes (copied from the checked-in models.json) matter
    // here: the fitsTier refusal tests below compare a tier's real budget
    // against a tiny simulated usable-memory figure, and a toy 1 MB fixture
    // would never exercise that path.
    small: [
      { id: "small-a", repo: "Org/A", file: "a.gguf", ctx: 4096, fileSize: 1_117_320_736 },
      { id: "small-b", repo: "Org/B", file: "b.gguf", ctx: 4096, fileSize: 2_104_932_768 },
    ],
    medium: [
      { id: "small-b", repo: "Org/B", file: "b.gguf", ctx: 4096, fileSize: 2_104_932_768 },
      { id: "medium-a", repo: "Org/C", file: "c.gguf", ctx: 8192, fileSize: 8_988_110_976 },
    ],
    large: [
      { id: "large-a", repo: "Org/D", file: "d.gguf", ctx: 8192, fileSize: 4_683_074_240 },
      { id: "large-b", repo: "Org/E", file: "e.gguf", ctx: 8192, fileSize: 19_851_336_576 },
    ],
  },
});

function fakeIo(initialFiles: Record<string, string> = {}): {
  io: Io;
  files: Map<string, string>;
  modes: Map<string, number | undefined>;
  logs: string[];
} {
  const files = new Map(Object.entries(initialFiles));
  const modes = new Map<string, number | undefined>();
  const logs: string[] = [];
  const io: Io = {
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, text, mode) => {
      files.set(path, text);
      modes.set(path, mode);
    },
    fetch: (() => {
      throw new Error("network must not be used when --skip-download is set");
    }) as unknown as typeof globalThis.fetch,
    log: (line) => logs.push(line),
    now: () => Date.parse("2026-09-20T10:00:00.000Z"),
  };
  return { io, files, modes, logs };
}

const GOOD_RAW_PROBE = {
  "/probe/kernel": "Linux\n",
  "/probe/arch": "x86_64\n",
  "/probe/cpu-cores": "8\n",
  "/probe/mem-total": "MemTotal:       33270484 kB\n",
  "/probe/docker-compose": "2.35.1\n",
  "/probe/lspci-display":
    "00:02.0 VGA compatible controller: Intel Corporation [Iris Xe Graphics] [8086:9a49]\n",
  "/probe/dev-dri": "card1\nrenderD128\n",
};

describe("run", () => {
  it("stops after writing probe.json when --probe-only is set, still returning a full report", async () => {
    const { io, files } = fakeIo(GOOD_RAW_PROBE);
    const args = parseArgs(["--raw-probe", "/probe", "--appliance", "/a", "--probe-only"]);
    const report = await run(args, io);
    expect(files.has("/a/probe.json")).toBe(true);
    expect(files.has("/a/.env")).toBe(false);
    expect(files.has("/a/compose.models.yml")).toBe(false);
    expect(report.wrote).toEqual(["/a/probe.json"]);
    expect(report.backend).toBeDefined();
    expect(report.tier).toBeDefined();
  });

  it("gates the Compose version, naming the found version and the stale-plugin trap", async () => {
    const { io } = fakeIo({ ...GOOD_RAW_PROBE, "/probe/docker-compose": "2.3.3\n" });
    const args = parseArgs([
      "--raw-probe",
      "/probe",
      "--appliance",
      "/a",
      "--models",
      "/a/models.json",
      "--skip-download",
    ]);
    await expect(run(args, io)).rejects.toThrow(/docker compose is 2\.3\.3/);
    await expect(run(args, io)).rejects.toThrow(/>= 2\.24/);
    await expect(run(args, io)).rejects.toThrow(
      /stale plugin at ~\/\.docker\/cli-plugins\/docker-compose/,
    );
  });

  it("refuses a tier forced onto a machine too small to actually run its pair", async () => {
    const { io } = fakeIo({
      ...GOOD_RAW_PROBE,
      "/probe/mem-total": "MemTotal:       4194304 kB\n", // ~4 GiB -> ~2.4 GiB usable
      "/a/models.json": MODELS_JSON,
    });
    const args = parseArgs([
      "--raw-probe",
      "/probe",
      "--appliance",
      "/a",
      "--backend",
      "cpu",
      "--tier",
      "large",
      "--skip-download",
    ]);
    await expect(run(args, io)).rejects.toThrow(/large/);
  });

  it("refuses the default small tier on a machine too small for even its own pair", async () => {
    const { io } = fakeIo({
      ...GOOD_RAW_PROBE,
      "/probe/mem-total": "MemTotal:       4194304 kB\n", // ~4 GiB -> ~2.4 GiB usable, forces "small"
      "/a/models.json": MODELS_JSON,
    });
    const args = parseArgs(["--raw-probe", "/probe", "--appliance", "/a", "--skip-download"]);
    await expect(run(args, io)).rejects.toThrow(/small/);
  });

  it("runs end to end with no disk and no network when --skip-download is set", async () => {
    const { io, files, modes, logs } = fakeIo({ ...GOOD_RAW_PROBE, "/a/models.json": MODELS_JSON });
    const args = parseArgs([
      "--raw-probe",
      "/probe",
      "--appliance",
      "/a",
      "--backend",
      "cpu",
      "--tier",
      "small",
      "--skip-download",
    ]);
    const report = await run(args, io);

    expect(report.backend.backend).toBe("cpu");
    expect(report.tier.tier).toBe("small");
    expect(files.has("/a/probe.json")).toBe(true);
    expect(files.has("/a/.env")).toBe(true);
    expect(modes.get("/a/.env")).toBe(0o600);
    expect(files.has("/a/compose.models.yml")).toBe(true);
    expect(files.has("/a/litellm/config.local.yaml")).toBe(true);
    expect(files.has("/a/prepare-report.json")).toBe(true);
    expect(logs.some((line) => line.includes(composeCommand()))).toBe(true);

    // carry-forward 4: the same serviceNameOf(id) value must reach both files.
    const compose = files.get("/a/compose.models.yml") as string;
    const litellm = files.get("/a/litellm/config.local.yaml") as string;
    expect(compose).toContain(`${serviceNameOf("small-a")}:`);
    expect(litellm).toContain(`http://${serviceNameOf("small-a")}:8080/v1`);
  });

  it("prints the admin password only when generated, never when preserved", async () => {
    const args = parseArgs([
      "--raw-probe",
      "/probe",
      "--appliance",
      "/a",
      "--backend",
      "cpu",
      "--tier",
      "small",
      "--skip-download",
    ]);

    const first = fakeIo({ ...GOOD_RAW_PROBE, "/a/models.json": MODELS_JSON });
    await run(args, first.io);
    const firstEnv = first.files.get("/a/.env") as string;
    const adminPassword = /ADMIN_PASSWORD=(\S+)/.exec(firstEnv)?.[1];
    expect(adminPassword).toBeTruthy();
    expect(first.logs.some((line) => line.includes(adminPassword as string))).toBe(true);

    // Second run, same appliance dir now carrying the .env the first run wrote:
    // the password must be preserved, and NOT printed again.
    const second = fakeIo({
      ...GOOD_RAW_PROBE,
      "/a/models.json": MODELS_JSON,
      "/a/.env": firstEnv,
    });
    await run(args, second.io);
    expect(second.files.get("/a/.env")).toContain(`ADMIN_PASSWORD=${adminPassword}`);
    expect(second.logs.some((line) => line.includes(adminPassword as string))).toBe(false);
  });

  it("threads the prior lock entry into ensureModel, so an up-to-date file is not re-downloaded (carry-forward 1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "appliance-"));
    try {
      for (const [name, text] of Object.entries(GOOD_RAW_PROBE)) {
        const rel = name.replace("/probe/", "");
        await mkdir(join(dir, "raw"), { recursive: true });
        await writeFile(join(dir, "raw", rel), text);
      }

      const entry = { id: "small-a", repo: "Org/A", file: "a.gguf", ctx: 4096, fileSize: 5 };
      await writeFile(
        join(dir, "models.json"),
        JSON.stringify({
          schemaVersion: 1,
          minUsableBytes: { small: 1, medium: 1, large: 1 },
          tiers: { small: [entry], medium: [], large: [] },
        }),
      );

      const modelDir = join(dir, "models", "small-a");
      await mkdir(modelDir, { recursive: true });
      const modelPath = join(modelDir, "a.gguf");
      await writeFile(modelPath, "hello");
      await writeFile(
        join(dir, "models", "manifest.lock.json"),
        JSON.stringify({
          schemaVersion: 1,
          models: [
            {
              id: "small-a",
              repo: "Org/A",
              file: "a.gguf",
              size: 5,
              sha256: "deadbeef",
              path: modelPath,
            },
          ],
        }),
      );

      let downloadCalls = 0;
      const fetchImpl = (async (url: string | URL) => {
        const href = String(url);
        if (href.includes("/api/models/")) {
          return new Response(
            JSON.stringify([{ path: "a.gguf", size: 5, lfs: { oid: "deadbeef" } }]),
          );
        }
        downloadCalls += 1;
        return new Response("hello", { headers: { "content-length": "5" } });
      }) as unknown as typeof globalThis.fetch;

      const io: Io = {
        readFile: (path) => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return null;
          }
        },
        writeFile: (path, text, mode) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text, mode !== undefined ? { mode } : undefined);
        },
        fetch: fetchImpl,
        log: () => {},
        now: () => Date.parse("2026-09-20T10:00:00.000Z"),
      };

      const args = parseArgs([
        "--raw-probe",
        join(dir, "raw"),
        "--appliance",
        dir,
        "--backend",
        "cpu",
        "--tier",
        "small",
      ]);
      const report = await run(args, io);
      expect(downloadCalls).toBe(0);
      expect(report.models).toEqual([
        {
          id: "small-a",
          repo: "Org/A",
          file: "a.gguf",
          size: 5,
          sha256: "deadbeef",
          path: modelPath,
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
