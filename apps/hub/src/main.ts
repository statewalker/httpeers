/**
 * The container entrypoint. Everything environment-shaped is here, so
 * `startDaemon` stays a function of its arguments.
 *
 * `main()` ONLY RUNS WHEN THIS FILE IS THE PROCESS ENTRY POINT (the guard at
 * the bottom). `modulesFor` is exported for `main.test.ts`, which needs to
 * import this file to reach it; without the guard, that import would itself
 * load real config from `process.env` and start contacting the real relay.
 */

import { pathToFileURL } from "node:url";
import { type HubConfig, loadConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import type { ServiceModule } from "./service-module.js";
import { llmModule } from "./services/llm/index.js";

/** Docker's default stop grace is 10 s; finish (or give up loudly) before SIGKILL. */
const STOP_DEADLINE_MS = 8_000;

/**
 * The built-in service modules, by id. `HUB_SERVICES` picks from these.
 *
 * `llm` needs both `HUB_LLM_UPSTREAM` and `LITELLM_MASTER_KEY`; enabling it
 * without either is a configuration error, not a silently half-working
 * service, so this throws before `startDaemon` ever runs.
 */
const MODULES: Record<string, (config: HubConfig) => ServiceModule> = {
  llm: (config) => {
    if (config.llmUpstream == null || config.litellmMasterKey == null) {
      const missing = [
        config.llmUpstream == null ? "HUB_LLM_UPSTREAM" : null,
        config.litellmMasterKey == null ? "LITELLM_MASTER_KEY" : null,
      ].filter((name): name is string => name != null);
      throw new Error(
        `hub: HUB_SERVICES includes "llm" but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set`,
      );
    }
    return llmModule({ upstream: config.llmUpstream, masterKey: config.litellmMasterKey });
  },
};

export function modulesFor(config: HubConfig): ServiceModule[] {
  return config.services.map((id) => {
    const make = MODULES[id];
    if (make == null) {
      const known = Object.keys(MODULES).join(", ") || "none";
      throw new Error(`hub: unknown service "${id}" in HUB_SERVICES (known: ${known})`);
    }
    return make(config);
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const daemon = await startDaemon(config, modulesFor(config));

  const shutdown = (signal: string) => {
    console.log(`hub: ${signal}, stopping`);
    // A hung libp2p stop must not swallow the exit: after the deadline, say so
    // and exit non-zero so the supervisor sees a failed shutdown.
    const deadline = setTimeout(() => {
      console.log(`hub: stop did not finish within ${STOP_DEADLINE_MS} ms, exiting`);
      process.exit(1);
    }, STOP_DEADLINE_MS);
    deadline.unref();
    // Flush first: revocations are the one state whose loss re-admits someone.
    daemon
      .revocationsFlushed()
      .catch((error: unknown) => {
        console.log(`hub: revocations flush failed: ${(error as Error).message}`);
        throw error;
      })
      .finally(() => daemon.stop())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          console.log(`hub: stop failed: ${(error as Error).message}`);
          process.exit(1);
        },
      );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.log(`hub: failed to start: ${(error as Error).stack ?? error}`);
    process.exit(1);
  });
}
