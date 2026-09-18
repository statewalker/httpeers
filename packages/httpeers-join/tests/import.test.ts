// @vitest-environment node
/**
 * The published entry, actually IMPORTED from `dist/` under plain Node -- no
 * DOM, no camera, no bundler.
 *
 * Two claims, both runtime-only, which is why a type check cannot make them:
 *
 *   - the entry a page bundles really exports the widget (the `exports` map
 *     points at a file that exists and evaluates);
 *   - importing it touches no DOM. A page's bundle evaluates this module before
 *     it has mounted anything, and a module that reached for `document` at the
 *     top level would fail there, or in any test that imports a page module.
 *
 * `html5-qrcode` must not be loaded by the import either: it is fetched on the
 * first scan. The last test holds that by name.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  exports: Record<string, { import: string }>;
};

describe("the built entry", () => {
  it("imports under Node, with no DOM, and exports the widget", async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    const entry = manifest.exports["."]?.import;
    expect(entry).toBe("./dist/index.js");
    const mod = (await import(pathToFileURL(join(PKG, entry as string)).href)) as Record<
      string,
      unknown
    >;
    expect(typeof mod.mountJoinWidget).toBe("function");
    expect(typeof mod.defaultQrScanner).toBe("function");
    expect(typeof mod.describePhase).toBe("function");
    expect(mod.JOIN_WIDGET_CSS).toMatch(/\.hp-join\b/);
  });

  it("offers no camera where there is no camera API", async () => {
    const { defaultQrScanner } = (await import(
      pathToFileURL(join(PKG, "dist/index.js")).href
    )) as typeof import("../src/index.js");
    expect(defaultQrScanner().cameraAvailable()).toBe(false);
  });

  it("does not load the camera library at import", () => {
    const built = readFileSync(join(PKG, "dist/qr.js"), "utf8");
    // Only as a dynamic import, never a static one.
    expect(built).toMatch(/import\("@statewalker\/httpeers-qr\/browser"\)/);
    expect(built).not.toMatch(/^import .*httpeers-qr\/browser/m);
    expect(built).not.toMatch(/from\s+["']html5-qrcode["']/);
  });
});
