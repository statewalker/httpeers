/**
 * The container entrypoint. Everything environment-shaped is here, so
 * `startDaemon` stays a function of its arguments.
 */

import { type HubConfig, loadConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import type { ServiceModule } from "./service-module.js";

/** Docker's default stop grace is 10 s; finish (or give up loudly) before SIGKILL. */
const STOP_DEADLINE_MS = 8_000;

/** The built-in service modules, by id. `HUB_SERVICES` picks from these. */
const MODULES: Record<string, (config: HubConfig) => ServiceModule> = {};

function modulesFor(config: HubConfig): ServiceModule[] {
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

main().catch((error: unknown) => {
  console.log(`hub: failed to start: ${(error as Error).stack ?? error}`);
  process.exit(1);
});
