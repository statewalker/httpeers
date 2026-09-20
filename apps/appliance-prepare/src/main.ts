/**
 * The prepare CLI.
 *
 * Wires Tasks 2-8's pure modules into the tool `bin/prepare.sh` runs inside a
 * stock `node:22-alpine` container (see that script): probe -> gate -> select
 * -> download -> render. Every side effect (reading and writing files,
 * `fetch`, logging, the clock) is injected through the `Io` parameter to
 * `run`, so the whole pipeline is exercised in tests with no real disk and no
 * network -- `--skip-download` additionally keeps `ensureModel` (which does
 * its own direct filesystem I/O; see download.ts) out of the loop entirely.
 *
 * `parseArgs`, `assembleProbe`, `composeCommand` and `run` are pure/injected
 * and fully testable; only the bottom guarded block touches the real world
 * (`process.argv`, `node:fs`, `process.exitCode`), and only when this file is
 * executed directly -- never when a test imports it.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { type Backend, type BackendChoice, chooseBackend } from "./backend.ts";
import { type ComposePlan, renderComposeModels, renderLlamaSwapConfig } from "./compose.ts";
import { ensureModel, type Lock, type LockEntry } from "./download.ts";
import { parseEnvFile, planSecrets, renderEnvFile } from "./env.ts";
import { type LitellmPlan, renderLitellmConfig } from "./litellm.ts";
import { type ModelEntry, parseManifest, serviceNameOf } from "./manifest.ts";
import { compareVersions, type Probe, parseLspciDisplay, parseNvidiaSmiCsv } from "./probe.ts";
import { chooseTier, fitsTier, type TierChoice, tierBudget } from "./tier.ts";

export interface Args {
  rawProbe?: string;
  appliance: string;
  probeOnly: boolean;
  rotateSecrets: boolean;
  models?: string;
  backend?: string;
  tier?: string;
  skipDownload: boolean;
  llamaswap: boolean;
}

export interface PrepareReport {
  probe: Probe;
  backend: BackendChoice;
  tier: TierChoice;
  models: LockEntry[];
  wrote: string[];
  command: string;
}

/** Every side effect `run` performs, injected so it never touches the real world directly. */
export interface Io {
  readFile(path: string): string | null;
  writeFile(path: string, text: string, mode?: number): void;
  fetch: typeof globalThis.fetch;
  log(line: string): void;
  now(): number;
}

const FLAGS_WITH_VALUE = new Set(["--raw-probe", "--appliance", "--models", "--backend", "--tier"]);
const FLAGS_BOOLEAN = new Set([
  "--probe-only",
  "--rotate-secrets",
  "--skip-download",
  "--llamaswap",
]);

/**
 * Parses `bin/prepare.sh`'s CLI arguments. Throws, naming the offending
 * flag, on anything it does not recognise -- an unknown flag silently
 * ignored is exactly the kind of thing that looks like it worked. `--appliance`
 * is the one required flag: everything else `run` writes is relative to it.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    appliance: "",
    probeOnly: false,
    rotateSecrets: false,
    skipDownload: false,
    llamaswap: false,
  };
  let hasAppliance = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (FLAGS_BOOLEAN.has(flag)) {
      if (flag === "--probe-only") args.probeOnly = true;
      else if (flag === "--rotate-secrets") args.rotateSecrets = true;
      else if (flag === "--skip-download") args.skipDownload = true;
      else if (flag === "--llamaswap") args.llamaswap = true;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Flag "${flag}" requires a value`);
      }
      i += 1;
      if (flag === "--raw-probe") args.rawProbe = value;
      else if (flag === "--appliance") {
        args.appliance = value;
        hasAppliance = true;
      } else if (flag === "--models") args.models = value;
      else if (flag === "--backend") args.backend = value;
      else if (flag === "--tier") args.tier = value;
      continue;
    }
    throw new Error(`Unknown flag "${flag}"`);
  }

  if (!hasAppliance) {
    throw new Error("--appliance is required");
  }
  return args;
}

/** The exact command line printed at the end of a run -- also step 9. */
export function composeCommand(): string {
  return "docker compose -f compose.yml -f compose.local.yml -f compose.models.yml up -d --wait";
}

function nonEmpty(text: string | null): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCores(text: string | null): number | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? undefined : n;
}

function parsePrettyName(text: string | null): string | undefined {
  if (text === null) return undefined;
  const match = text.match(/PRETTY_NAME="?([^"\n]*)"?/);
  return match ? match[1] : undefined;
}

function parseMemTotal(text: string | null): number | undefined {
  if (text === null) return undefined;
  const match = text.match(/(\d+)\s*kB/i);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10) * 1024;
}

function parseDockerRuntimes(text: string | null): string[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (parsed !== null && typeof parsed === "object") return Object.keys(parsed);
  } catch {
    // Host probe output, not a trusted format -- tolerate garbage.
  }
  return [];
}

function parseLines(text: string | null): string[] {
  if (text === null) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Assembles a `Probe` from the raw command output `bin/prepare.sh` writes,
 * one named file per probe (`kernel`, `arch`, `os-pretty-name`, `cpu-cores`,
 * `mem-total`, `docker-engine`, `docker-compose`, `docker-runtimes`,
 * `nvidia-smi`, `lspci-display`, `dev-dri`, `dev-mtgpu`, `kfd-exit`).
 * `read` is injected so this stays a pure function of its inputs -- it never
 * touches `rawDir` itself, and never shells out.
 *
 * `collectedAt` is deliberately left empty here: this function has no clock,
 * by design (see `Io.now`). `run` fills it in after calling this.
 *
 * Every raw file is optional -- a probe from a machine with no `lspci`, or a
 * raw dir with nothing in it at all, is still a valid `Probe` that selects
 * `cpu`. Building the object field-by-field (never string-concatenating
 * JSON) is also why a GPU name containing a quote survives intact: it is
 * assigned as a plain JS string and only ever serialised by `JSON.stringify`.
 */
export function assembleProbe(rawDir: string, read: (name: string) => string | null): Probe {
  void rawDir; // `read` already resolves names against it; kept for signature parity with the brief.

  const nvidiaSmiRaw = read("nvidia-smi");
  const lspciDisplayRaw = read("lspci-display");

  return {
    schemaVersion: 1,
    collectedAt: "",
    os: {
      kernel: nonEmpty(read("kernel")),
      arch: nonEmpty(read("arch")),
      prettyName: parsePrettyName(read("os-pretty-name")),
    },
    cpu: { cores: parseCores(read("cpu-cores")) },
    memory: { totalBytes: parseMemTotal(read("mem-total")) },
    docker: {
      engine: nonEmpty(read("docker-engine")),
      compose: nonEmpty(read("docker-compose")),
    },
    dockerRuntimes: parseDockerRuntimes(read("docker-runtimes")),
    nvidiaSmi:
      nvidiaSmiRaw === null || nvidiaSmiRaw.trim() === ""
        ? null
        : { gpus: parseNvidiaSmiCsv(nvidiaSmiRaw) },
    pciDisplay: lspciDisplayRaw === null ? [] : parseLspciDisplay(lspciDisplayRaw),
    deviceNodes: {
      dri: parseLines(read("dev-dri")),
      mtgpu: parseLines(read("dev-mtgpu")),
      kfd: read("kfd-exit")?.trim() === "0",
    },
  };
}

const MIN_COMPOSE_VERSION = "2.24";

/**
 * §3.14/D2: below 2.24, refuse rather than let compose fail later with a
 * less legible error. The stale-plugin sentence is there because that is
 * exactly what happened on this project on 2026-09-20 (see the module intro
 * of `probe.ts`'s `compareVersions` and the design doc's derived decision
 * D2): `docker compose version` reported v2.3.3 while the system plugin was
 * v2.35.1, a 2022-era `~/.docker/cli-plugins/docker-compose` shadowing it.
 */
function gateComposeVersion(found: string | undefined): void {
  if (found === undefined || compareVersions(found, MIN_COMPOSE_VERSION) < 0) {
    throw new Error(
      `docker compose is ${found ?? "unknown"}; this appliance needs >= ${MIN_COMPOSE_VERSION}. ` +
        "If you have a modern Docker, check for a stale plugin at " +
        "~/.docker/cli-plugins/docker-compose shadowing the system one.",
    );
  }
}

/**
 * Runs the whole pipeline: probe -> gate -> select -> download -> render.
 * See the module intro and `docs/superpowers/specs/2026-09-20-llm-appliance-local-models-design.md`
 * §8 for what each step writes. Every side effect goes through `io`.
 */
export async function run(args: Args, io: Io): Promise<PrepareReport> {
  const wrote: string[] = [];

  // Step 1: assemble and write probe.json.
  const rawDir = args.rawProbe;
  const readRaw = (name: string): string | null =>
    rawDir === undefined ? null : io.readFile(join(rawDir, name));
  const assembled = assembleProbe(rawDir ?? "", readRaw);
  const probe: Probe = { ...assembled, collectedAt: new Date(io.now()).toISOString() };

  const probePath = join(args.appliance, "probe.json");
  io.writeFile(probePath, `${JSON.stringify(probe, null, 2)}\n`);
  wrote.push(probePath);
  io.log(`Wrote ${probePath}`);

  // Selection is pure and cheap, so it is always computed -- even under
  // --probe-only -- purely to populate the report; it is never printed or
  // acted upon (no gate, no download, no further writes) in that mode.
  const backend = chooseBackend(probe, args.backend);
  const tier = chooseTier(probe, backend.backend, args.tier);

  if (args.probeOnly) {
    return { probe, backend, tier, models: [], wrote, command: composeCommand() };
  }

  // Step 2: gate the Compose version.
  gateComposeVersion(probe.docker.compose);

  // Step 3: print the backend and tier choices, and every warning.
  io.log(`Backend: ${backend.backend} (${backend.reason})`);
  for (const warning of backend.warnings) {
    io.log(`Warning: ${warning}`);
  }
  io.log(`Tier: ${tier.tier} (${tier.reason})`);

  // Step 4: read models.json, resolve the tier's entries, and refuse if they
  // do not fit THIS machine's actual detected usable memory -- not just the
  // manifest's own static minUsableBytes floor (which models.json's own
  // tests already keep true by construction). This is the check that is
  // reachable for "small", which has no lower band.
  const modelsPath = args.models ?? join(args.appliance, "models.json");
  const modelsText = io.readFile(modelsPath);
  if (modelsText === null) {
    throw new Error(`Could not read the model manifest at ${modelsPath}`);
  }
  const manifest = parseManifest(modelsText);
  const entries: ModelEntry[] = manifest.tiers[tier.tier];
  if (!fitsTier(entries, tier.usableBytes)) {
    const budget = tierBudget(entries);
    throw new Error(
      `Tier "${tier.tier}" needs ${budget} bytes to run both its models, but only ` +
        `${tier.usableBytes} bytes are usable on this machine (this tier's own floor is ` +
        `${manifest.minUsableBytes[tier.tier]} bytes); refusing to download and then OOM.`,
    );
  }
  io.log(`Models: ${entries.map((entry) => entry.id).join(", ")}`);

  const threads = probe.cpu.cores ?? 1;

  // Read any existing .env EARLY -- before step 5, not step 6 -- because
  // APPLIANCE_MODELS_DIR, when an operator has already set it (e.g. a 20 GB
  // pair pointed at a second disk), decides where downloads land. Reading it
  // late enough to only affect step 6's own write would leave step 5
  // downloading to the wrong place while Compose mounts the right one.
  //
  // APPLIANCE_MODELS_DIR is stored and written back RELATIVE -- never as a
  // path resolved against this container's own filesystem. It is read by
  // two different processes on two different sides of the bind mount: this
  // tool (inside the node:22-alpine container bin/prepare.sh runs, which
  // sees the repo at /work) when it downloads, and `docker compose` itself
  // (running directly ON THE HOST, never containerised -- see README.md)
  // when it resolves compose.models.yml's `${APPLIANCE_MODELS_DIR:-./models}`
  // bind-mount source. A relative value resolves correctly against BOTH:
  // Compose resolves it against the compose file's directory
  // (`deploy/llm-appliance`), and this tool resolves it against
  // `args.appliance`, which `bin/prepare.sh` always passes as that same
  // directory's path as seen inside the container. An earlier version of
  // this function defaulted to `join(args.appliance, "models")` -- an
  // ABSOLUTE container path (e.g. "/work/deploy/llm-appliance/models") --
  // and wrote that straight into .env; docker compose then read it back on
  // the host, where "/work" does not exist, and every llama-server would
  // have bind-mounted an empty directory. VERIFIED against a real bring-up
  // on 2026-09-20 (Task 10): `docker compose config` resolved the model
  // mount source to that nonexistent /work path.
  //
  // An operator-supplied ABSOLUTE value is refused outright, not silently
  // redirected: this tool only ever sees the repository bind-mounted at
  // /work, so it cannot write anywhere else, and Compose reading the same
  // absolute string would (by luck, not by design) point somewhere
  // completely different on the host than wherever this tool just wrote.
  const envPath = join(args.appliance, ".env");
  const previousEnvText = io.readFile(envPath);
  const previousEnv =
    previousEnvText === null ? new Map<string, string>() : parseEnvFile(previousEnvText);
  const modelsDirSetting = (previousEnv.get("APPLIANCE_MODELS_DIR") ?? "").trim() || "./models";
  if (isAbsolute(modelsDirSetting)) {
    throw new Error(
      `APPLIANCE_MODELS_DIR="${modelsDirSetting}" is an absolute path, but this tool only ever sees ` +
        "the repository bind-mounted at /work inside its container -- it cannot write anywhere else, " +
        "and docker compose (which runs directly on the host, never containerised) would resolve that " +
        "same absolute string against the host's filesystem instead, which is not what just downloaded " +
        'the models. Use a path relative to the appliance directory (the default is "./models"), or ' +
        "bind-mount your directory into the prepare container yourself and point APPLIANCE_MODELS_DIR " +
        "at its path as seen INSIDE that container.",
    );
  }
  const modelsDir = join(args.appliance, modelsDirSetting);

  // Step 5: ensureModel each, threading `previous` from the lock file --
  // carry-forward 1. `models/manifest.lock.json` I/O belongs to this CLI
  // alone; download.ts never reads or writes it. The lock lives alongside
  // the actual downloaded files, so it follows modelsDir too.
  const lockPath = join(modelsDir, "manifest.lock.json");
  const previousLockText = io.readFile(lockPath);
  const previousLock: Lock | null = previousLockText === null ? null : JSON.parse(previousLockText);
  const previousById = new Map<string, LockEntry>(
    (previousLock?.models ?? []).map((entry) => [entry.id, entry]),
  );

  let lockEntries: LockEntry[];
  if (args.skipDownload) {
    io.log("Skipping model downloads (--skip-download)");
    lockEntries = entries.map(
      (entry) =>
        previousById.get(entry.id) ?? {
          id: entry.id,
          repo: entry.repo,
          file: entry.file,
          size: entry.fileSize,
          sha256: null,
          path: join(modelsDir, entry.id, entry.file),
        },
    );
  } else {
    lockEntries = [];
    for (const entry of entries) {
      const previous = previousById.get(entry.id) ?? null;
      const lockEntry = await ensureModel(entry, {
        dir: modelsDir,
        fetch: io.fetch,
        log: io.log,
        previous,
      });
      lockEntries.push(lockEntry);
    }
    const lock: Lock = { schemaVersion: 1, models: lockEntries };
    io.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    wrote.push(lockPath);
  }

  // APPLIANCE_DOOR_PORT: preserved like APPLIANCE_MODELS_DIR -- an
  // operator's own choice, never derived from the probe/backend/tier --
  // defaulting to 8080 (today's behaviour when an operator sets nothing).
  // compose.local.yml's `traefik.ports` reads it with the same default, so
  // an unset value publishes the door exactly where it always has.
  //
  // Validated as an integer in 1-65535 here, not left for `docker compose
  // up` to reject three steps later with a much less legible error.
  const doorPortSetting = (previousEnv.get("APPLIANCE_DOOR_PORT") ?? "").trim() || "8080";
  const doorPort = Number.parseInt(doorPortSetting, 10);
  if (!/^\d+$/.test(doorPortSetting) || doorPort < 1 || doorPort > 65535) {
    throw new Error(
      `APPLIANCE_DOOR_PORT="${doorPortSetting}" is not a valid port -- it must be an integer ` +
        "between 1 and 65535.",
    );
  }
  // HUB_DOOR_ALLOWED_HOSTS is the opposite of APPLIANCE_DOOR_PORT: it is
  // ALWAYS derived from the resolved port, never preserved on its own.
  // compose.yml gates the hub's local door on this allowlist (defaulting to
  // 127.0.0.1:8080,localhost:8080 -- see compose.yml's `hub.environment`);
  // if the published port moved but this allowlist did not follow, Traefik
  // would forward a Host the door refuses, and the failure would look like
  // a broken door rather than what it actually is: two values that must
  // agree, silently drifting apart. Keeping them derived from one
  // `doorPort` here is the same discipline as APPLIANCE_MODELS_DIR/
  // modelsDir above, applied to the second instance of it this branch
  // turned up.
  const doorAllowedHosts = `127.0.0.1:${doorPort},localhost:${doorPort}`;

  // Step 6: .env -- plan the nine secrets, add the derived, non-secret keys
  // spec §8 also requires (LLAMA_BACKEND, LLAMA_IMAGE, LLAMA_TIER,
  // LLAMA_THREADS, APPLIANCE_MODELS_DIR, APPLIANCE_DOOR_PORT,
  // HUB_DOOR_ALLOWED_HOSTS), and write mode 600. Print the admin password
  // only when it was freshly generated.
  //
  // LLAMA_BACKEND/LLAMA_IMAGE/LLAMA_TIER/LLAMA_THREADS/HUB_DOOR_ALLOWED_HOSTS
  // are NOT secrets: planSecrets' preserve-unless---rotate-secrets rule does
  // not apply to them. They describe THIS run's selection (or, for
  // HUB_DOOR_ALLOWED_HOSTS, are derived from one that does) and are
  // rewritten every run -- otherwise re-running prepare after picking a
  // different --backend/--tier would leave .env describing the previous
  // run, and Task 10's verify-backend.sh (which reads LLAMA_BACKEND
  // straight out of .env) would check against a stale value.
  // APPLIANCE_MODELS_DIR and APPLIANCE_DOOR_PORT are the exceptions:
  // `modelsDirSetting`/`doorPortSetting` above already preserved whatever
  // the operator had set (or defaulted), so writing them back here is a
  // no-op unless this is the first run. APPLIANCE_MODELS_DIR is written
  // back as the RELATIVE setting, never the resolved `modelsDir` -- see the
  // long comment above `modelsDirSetting` for why an absolute,
  // container-resolved path in .env breaks docker compose on the host.
  const secretPlan = planSecrets(previousEnv, { rotate: args.rotateSecrets });
  const envValues = new Map(secretPlan.values);
  envValues.set("LLAMA_BACKEND", backend.backend);
  envValues.set("LLAMA_IMAGE", backend.image);
  envValues.set("LLAMA_TIER", tier.tier);
  envValues.set("LLAMA_THREADS", String(threads));
  envValues.set("APPLIANCE_MODELS_DIR", modelsDirSetting);
  envValues.set("APPLIANCE_DOOR_PORT", String(doorPort));
  envValues.set("HUB_DOOR_ALLOWED_HOSTS", doorAllowedHosts);
  const envText = renderEnvFile(envValues, previousEnvText);
  io.writeFile(envPath, envText, 0o600);
  wrote.push(envPath);
  if (secretPlan.generated.includes("ADMIN_PASSWORD")) {
    io.log(`Generated ADMIN_PASSWORD: ${secretPlan.values.get("ADMIN_PASSWORD")}`);
  } else {
    io.log("ADMIN_PASSWORD preserved from the existing .env");
  }

  // Step 7: compose.models.yml and litellm/config.local.yaml. Carry-forward
  // 4: serviceNameOf(id) is computed once per model and reused for both --
  // never re-derived as a literal "llamacpp-<id>" string in either renderer.
  const modelsWithService = entries.map((entry) => ({ entry, service: serviceNameOf(entry.id) }));

  const composePlan: ComposePlan = {
    backend: backend.backend as Backend,
    image: backend.image,
    threads,
    models: modelsWithService,
  };
  const composeModelsPath = join(args.appliance, "compose.models.yml");
  io.writeFile(composeModelsPath, renderComposeModels(composePlan));
  wrote.push(composeModelsPath);

  // --llamaswap: compose.models.yml above is written unconditionally either
  // way (prepare does not special-case it away -- see compose.llamaswap.yml's
  // own header on why that is fine to reference but never start). This is
  // the one place behaviour actually branches: llamaswap/config.yaml is
  // written ONLY under --llamaswap, and every local model's LiteLLM entry
  // below is routed at the single "llamaswap" service instead of its own
  // "llamacpp-<id>" one -- LitellmPlan already takes {id, service} per
  // model, so this needs no interface change, only a different `service`
  // value per entry.
  if (args.llamaswap) {
    const llamaswapConfigPath = join(args.appliance, "llamaswap", "config.yaml");
    io.writeFile(llamaswapConfigPath, renderLlamaSwapConfig(composePlan));
    wrote.push(llamaswapConfigPath);
  }

  const openrouter = (previousEnv.get("OPENROUTER_API_KEY") ?? "").trim() !== "";
  const litellmPlan: LitellmPlan = {
    models: modelsWithService.map(({ entry, service }) => ({
      id: entry.id,
      service: args.llamaswap ? "llamaswap" : service,
    })),
    openrouter,
  };
  const litellmPath = join(args.appliance, "litellm", "config.local.yaml");
  io.writeFile(litellmPath, renderLitellmConfig(litellmPlan));
  wrote.push(litellmPath);

  // Step 8: prepare-report.json.
  const reportPath = join(args.appliance, "prepare-report.json");
  wrote.push(reportPath);
  const report: PrepareReport = {
    probe,
    backend,
    tier,
    models: lockEntries,
    wrote,
    command: composeCommand(),
  };
  io.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  // Step 9: print the compose command.
  io.log(composeCommand());

  return report;
}

/**
 * The real `Io` `main()` runs with: `node:fs` underneath every method.
 * Exported (not just inlined in `main()`) so the mode-on-an-existing-file
 * behaviour of `writeFile` -- easy to get wrong, since `writeFileSync`'s own
 * `mode` option only applies when it creates the file -- is directly
 * testable against a real temp-dir file, not just the argument a fake `Io`
 * was called with.
 */
export function createNodeIo(): Io {
  return {
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile(path, text, mode) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, mode !== undefined ? { mode } : undefined);
      // `writeFileSync`'s `mode` option only applies when the file is
      // CREATED -- an operator who already has a 644 .env (e.g. from
      // `cp .env.example .env`, per README.md) keeps 644 unless the mode is
      // applied explicitly after the write, every time, regardless of
      // whether the file existed before.
      if (mode !== undefined) {
        chmodSync(path, mode);
      }
    },
    fetch: globalThis.fetch,
    log(line) {
      console.log(line);
    },
    now() {
      return Date.now();
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const io = createNodeIo();

  try {
    await run(args, io);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Runs only when this file is executed directly (as `bin/prepare.sh` does),
// never when a test imports it as a module.
const entryPoint = process.argv[1] ? resolvePath(process.argv[1]) : undefined;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main();
}
