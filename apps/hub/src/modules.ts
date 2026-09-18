/**
 * Resolves `HUB_SERVICES` against the built-in service-module registry.
 *
 * KEPT OUT OF `main.ts` DELIBERATELY. `main.ts` has a real top-level side
 * effect (it starts the daemon against `process.env` and the real relay);
 * importing it from a test to reach this logic would trigger that. An
 * earlier version of this guarded `main()` behind an
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check instead,
 * but that comparison silently fails (and so silently skips `main()`) when
 * the process is launched through a symlinked path — a real risk for a
 * container entrypoint. Splitting this out removes the need for any guard:
 * `main.ts` is safe to import only when it is actually meant to run.
 */

import type { HubConfig } from "./config.js";
import type { ServiceModule } from "./service-module.js";
import { llmModule } from "./services/llm/index.js";

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
