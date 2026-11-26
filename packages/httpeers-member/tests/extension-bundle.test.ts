/**
 * An offscreen-document bundle builds WITHOUT `@statewalker/webrun-http-browser`
 * (statewalker/httpeers#163): `./extension` is bundled whole, for the browser,
 * with that package made unresolvable. `./browser`, which re-exports the
 * ServiceWorker edge, fails the same build, which proves the probe works.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const FORBIDDEN = /^@statewalker\/webrun-http-browser(\/|$)/;

async function bundle(entry: string): Promise<{ requested: string[]; code: string }> {
  const requested: string[] = [];
  const build = await rolldown({
    input: join(SRC, entry),
    platform: "browser",
    logLevel: "silent",
    resolve: { conditionNames: ["source", "browser", "import", "default"] },
    plugins: [
      {
        name: "no-webrun-http-browser",
        resolveId(source) {
          if (FORBIDDEN.test(source)) {
            requested.push(source);
            throw new Error(`Could not resolve ${source}`);
          }
          return null;
        },
      },
    ],
  });
  try {
    const { output } = await build.generate({ format: "esm" });
    return { requested, code: output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("") };
  } finally {
    await build.close();
  }
}

describe("an edge-free bundle", () => {
  it("./extension bundles for the browser with webrun-http-browser unresolvable", async () => {
    const { requested, code } = await bundle("extension.ts");
    expect(requested).toEqual([]);
    expect(code).toContain("extensionPlatform");
    expect(code.length).toBeGreaterThan(100_000); // libp2p and the profile are really in it
  }, 120_000);

  it("./browser-hub bundles for the browser with webrun-http-browser unresolvable", async () => {
    const { requested, code } = await bundle("hub-entry.ts");
    expect(requested).toEqual([]);
    expect(code).toContain("startBrowserHub");
  }, 120_000);

  it("./browser does not, because it re-exports the edge", async () => {
    await expect(bundle("browser.ts")).rejects.toThrow(/webrun-http-browser/);
  }, 120_000);
});
