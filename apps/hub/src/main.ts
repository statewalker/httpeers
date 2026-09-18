/**
 * The container entrypoint. Everything environment-shaped is here, so
 * `startDaemon` stays a function of its arguments.
 *
 * NO ENTRY-POINT GUARD. `modulesFor` (the one piece worth unit-testing here)
 * lives in `modules.ts` instead, precisely so this file can run
 * unconditionally when executed — see that module's comment for why an
 * `import.meta.url` vs. `argv[1]` guard is the wrong fix (it silently no-ops
 * under a symlinked entrypoint).
 */

import { loadConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { modulesFor } from "./modules.js";

/** Docker's default stop grace is 10 s; finish (or give up loudly) before SIGKILL. */
const STOP_DEADLINE_MS = 8_000;

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
