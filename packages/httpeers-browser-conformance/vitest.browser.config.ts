// Browser-mode config for this package's `test:browser` script. It exists
// separately from the repo-root `vitest.config.ts` because `vitest run
// --config <file>` replaces the root config entirely rather than merging with
// it — so the workspace source aliases have to be restated here.
//
// Exported as a plain object, for the same reason the root config is: this
// file is loaded from a package directory whose `node_modules` does not
// necessarily resolve "vitest/config" for the loader. `defineConfig` is only
// a typing helper.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";

// Resolve every `@statewalker/webrun-*` workspace import to its TypeScript
// source, mirroring the root `vitest.config.ts` and `tsconfig.base.json`'s
// `paths`. Without it the package `exports` maps send vitest to `dist/`, and
// the browser suite would silently test the last build rather than the tree.
const packagesUrl = new URL("../", import.meta.url);
const webrunUrl = new URL("../../../webrun-wire/packages/", import.meta.url);

function aliasesIn(baseUrl: URL) {
  return readdirSync(fileURLToPath(baseUrl)).flatMap((name) => {
  const srcUrl = new URL(`${name}/src/`, baseUrl);
  if (!existsSync(new URL("index.ts", srcUrl))) return [];
  const specifier = `@statewalker/${name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const srcDir = fileURLToPath(srcUrl);
  return [
    // Subpath first: the more specific pattern has to win.
    { find: new RegExp(`^${specifier}/(.+)$`), replacement: `${srcDir}$1.ts` },
    { find: new RegExp(`^${specifier}$`), replacement: `${srcDir}index.ts` },
  ];
  });
}

// Both repos: this package tests httpeers' browser entries, which sit on
// webrun-http-browser's ServiceWorker adapter.
const alias = [...aliasesIn(packagesUrl), ...aliasesIn(webrunUrl)];

// biscuit-wasm's `exports` map is `{ "import": "./module/biscuit.js" }` with no
// wildcard, so the deep imports the loader seam needs are unreachable by any
// strict resolver. These two aliases are the "documented bundler alias" that
// `httpeers-access/engine` says a caller must supply -- and a demo app will
// need the same two lines in its own Vite config.
const biscuit = fileURLToPath(
  new URL("../../../../node_modules/.pnpm/@biscuit-auth+biscuit-wasm@0.6.0/node_modules/@biscuit-auth/biscuit-wasm/module/", import.meta.url),
);

export default {
  // Keep the aliased entry out of the dependency pre-bundler: an optimized
  // copy would be a SECOND module instance, and arming one leaves the other
  // -- the one the library actually calls -- holding no wasm.
  optimizeDeps: { exclude: ["@biscuit-auth/biscuit-wasm"] },
  resolve: {
    alias: [
      // THE ENTRY ITSELF, redirected to the binding module. biscuit-wasm's
      // published entry runs `__wbg_set_wasm(wasm)` where `wasm` is a `.wasm`
      // import -- a MODULE in Node, a URL STRING under Vite. Left in place it
      // loads whenever anything imports the package and overwrites whatever
      // the loader seam armed, with a string. Pointing the entry at the
      // binding module removes that side effect; `biscuit.js` is only
      // `export * from "./biscuit_bg.js"` plus that one line.
      { find: /^@biscuit-auth\/biscuit-wasm$/, replacement: `${biscuit}biscuit_bg.js` },
      { find: "#biscuit-binding", replacement: `${biscuit}biscuit_bg.js` },
      { find: "#biscuit-snippet", replacement: `${biscuit}snippets/biscuit-auth-314ca57174ae0e6d/inline0.js` },
      { find: "#biscuit-wasm-url", replacement: `${biscuit}biscuit_bg.wasm` },
      ...alias,
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
};
