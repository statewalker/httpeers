/**
 * `modulesFor` (`src/modules.ts`): resolves `HUB_SERVICES` against the
 * built-in registry. `llm` is the one entry with its own preconditions —
 * both `HUB_LLM_UPSTREAM` and `LITELLM_MASTER_KEY` must be set, or the
 * daemon must refuse to start with a clear error, before any network step.
 *
 * Deliberately does NOT import `main.ts`: that file's top-level `main()` call
 * has a real side effect (starts a daemon against `process.env`); `modulesFor`
 * lives in its own module precisely so this can exercise it without that.
 */

import { describe, expect, it } from "vitest";
import type { HubConfig } from "../src/config.js";
import { modulesFor } from "../src/modules.js";

function configWith(overrides: Partial<HubConfig>): HubConfig {
  return {
    dataDir: "/data",
    relayDoc: "https://relay.test/relay.json",
    services: [],
    joinPageUrl: "https://example.test/mesh.html",
    localDoorPort: 0,
    localDoorHost: "127.0.0.1",
    ...overrides,
  };
}

describe("modulesFor", () => {
  it("builds the llm module when both HUB_LLM_UPSTREAM and LITELLM_MASTER_KEY are set", () => {
    const modules = modulesFor(
      configWith({
        services: ["llm"],
        llmUpstream: "http://litellm:4000",
        litellmMasterKey: "sk-master",
      }),
    );
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("llm");
    expect(modules[0]?.advertisement).toEqual({ id: "llm", kind: "openapi-service", title: "LLM" });
  });

  it("refuses to start when llm is enabled without HUB_LLM_UPSTREAM", () => {
    expect(() =>
      modulesFor(configWith({ services: ["llm"], litellmMasterKey: "sk-master" })),
    ).toThrow(/HUB_LLM_UPSTREAM/);
  });

  it("refuses to start when llm is enabled without LITELLM_MASTER_KEY", () => {
    expect(() =>
      modulesFor(configWith({ services: ["llm"], llmUpstream: "http://litellm:4000" })),
    ).toThrow(/LITELLM_MASTER_KEY/);
  });

  it("refuses to start when llm is enabled with neither value set, naming both", () => {
    expect(() => modulesFor(configWith({ services: ["llm"] }))).toThrow(
      /HUB_LLM_UPSTREAM.*LITELLM_MASTER_KEY/,
    );
  });

  it("still refuses an unknown service", () => {
    expect(() => modulesFor(configWith({ services: ["nope"] }))).toThrow(/unknown service "nope"/);
  });
});
