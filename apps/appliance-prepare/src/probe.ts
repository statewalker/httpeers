/**
 * The probe contract.
 *
 * A `Probe` is the pure-data snapshot of a host's hardware and container
 * runtime. `bin/prepare.sh` collects the raw command output on the host and
 * the container assembles it into `probe.json`; everything downstream
 * (backend selection, tier selection, compose generation) is a pure function
 * over that file. That is also why a probe recorded on one machine can drive
 * another machine's tests: replay the JSON, no hardware required.
 */

const SCHEMA_VERSION = 1;

export interface Probe {
  schemaVersion: 1;
  collectedAt: string;
  os: { kernel?: string; arch?: string; prettyName?: string };
  cpu: { cores?: number };
  memory: { totalBytes?: number };
  docker: { engine?: string; compose?: string };
  dockerRuntimes: string[];
  nvidiaSmi: { gpus: NvidiaGpu[] } | null;
  pciDisplay: PciDisplay[];
  deviceNodes: { dri: string[]; mtgpu: string[]; kfd: boolean };
}

export interface NvidiaGpu {
  name: string;
  memoryTotalMiB: number;
  driver: string;
}

export interface PciDisplay {
  raw: string;
  vendorId?: string;
  deviceId?: string;
}

/** Thrown by `parseProbe` when the input names a `schemaVersion` this build does not understand. */
export class UnsupportedSchemaVersionError extends Error {
  constructor(found: number) {
    super(`Unsupported probe schemaVersion ${found}, expected ${SCHEMA_VERSION}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

/**
 * Parses a `probe.json` document, filling every absent field with an empty
 * default so downstream code never has to branch on `undefined` containers.
 */
export function parseProbe(text: string): Probe {
  // `schemaVersion` is typed as the plain literal `number` here, not `Probe`'s
  // `1`: casting the parsed JSON straight to `Partial<Probe>` would narrow the
  // "not equal to 1" branch below to `undefined` only, and lose the actual
  // (wrong) value we need to report in the error.
  const raw = JSON.parse(text) as Partial<Omit<Probe, "schemaVersion">> & {
    schemaVersion?: number;
  };
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(raw.schemaVersion as number);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    collectedAt: raw.collectedAt ?? "",
    os: raw.os ?? {},
    cpu: raw.cpu ?? {},
    memory: raw.memory ?? {},
    docker: raw.docker ?? {},
    dockerRuntimes: raw.dockerRuntimes ?? [],
    nvidiaSmi: raw.nvidiaSmi ?? null,
    pciDisplay: raw.pciDisplay ?? [],
    deviceNodes: {
      dri: raw.deviceNodes?.dri ?? [],
      mtgpu: raw.deviceNodes?.mtgpu ?? [],
      kfd: raw.deviceNodes?.kfd ?? false,
    },
  };
}

/**
 * Parses `nvidia-smi --query-gpu=name,memory.total,driver_version
 * --format=csv,noheader` output. Skips any line that does not yield exactly
 * three comma-separated fields instead of throwing — this is host probe
 * output, not a trusted format, and `nvidia-smi` prints prose ("No devices
 * were found") when there is nothing to report.
 */
export function parseNvidiaSmiCsv(text: string): NvidiaGpu[] {
  const gpus: NvidiaGpu[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length !== 3) continue;
    const [name, memory, driver] = fields;
    const memoryTotalMiB = Number.parseInt(memory.replace(/\s*MiB$/i, ""), 10);
    if (Number.isNaN(memoryTotalMiB)) continue;
    gpus.push({ name, memoryTotalMiB, driver });
  }
  return gpus;
}

const LSPCI_ID_PAIR = /\[([0-9a-f]{4}):([0-9a-f]{4})\]/i;

/**
 * Parses `lspci -nn | grep -Ei 'vga|3d|display'` output, one display
 * controller per line. Extracts the `[vendor:device]` id pair when present;
 * keeps the raw line either way.
 */
export function parseLspciDisplay(text: string): PciDisplay[] {
  const entries: PciDisplay[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = line.match(LSPCI_ID_PAIR);
    entries.push(match ? { raw: line, vendorId: match[1], deviceId: match[2] } : { raw: line });
  }
  return entries;
}

/**
 * Semver-ish numeric compare, used for the Compose version gate. A plain
 * string compare gets "2.3.3" vs "2.24.0" wrong; this splits on `.`, coerces
 * each part with `Number.parseInt`, and treats a missing part as `0`.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".");
  const partsB = b.split(".");
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const numA = Number.parseInt(partsA[i] ?? "0", 10) || 0;
    const numB = Number.parseInt(partsB[i] ?? "0", 10) || 0;
    if (numA !== numB) return numA < numB ? -1 : 1;
  }
  return 0;
}
