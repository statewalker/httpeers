/**
 * The shell's two pages. The worker is a separate build (`vite.sw.config.ts`).
 *
 * ASSETS UNDER `/_shell/`, NOT VITE'S DEFAULT `/assets/`. The worker hands
 * every path to the app except the shell's own, and `/assets/` is exactly the
 * directory an app is most likely to use itself. A prefix no app would pick
 * keeps the two from colliding.
 */
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Drop emitted files that nothing in the output refers to.
 *
 * `webrun-http-browser`'s `dist/index.js` carries default arguments of the
 * form `new URL("../", import.meta.url)`. Vite resolves those at TRANSFORM
 * time -- before tree-shaking removes the functions that hold them -- and
 * emits a copy of the whole 91 KB library file as an asset that no page ever
 * loads. Nothing here uses those defaults, so the copy is dead weight on every
 * session origin.
 */
function dropUnreferencedAssets(): Plugin {
  return {
    name: "session-shell:drop-unreferenced-assets",
    generateBundle(_options, bundle) {
      const texts = Object.values(bundle).map((file) =>
        file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "",
      );
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type !== "asset" || name.endsWith(".html")) continue;
        const base = name.slice(name.lastIndexOf("/") + 1);
        if (!texts.some((text) => text.includes(base))) delete bundle[name];
      }
    },
  };
}

export default defineConfig({
  plugins: [dropUnreferencedAssets()],
  root: "src",
  publicDir: join(process.cwd(), "public"),
  build: {
    outDir: join(process.cwd(), "dist", "site"),
    emptyOutDir: true,
    assetsDir: "_shell",
    rollupOptions: {
      input: {
        relay: join(process.cwd(), "src", "relay.html"),
        index: join(process.cwd(), "src", "index.html"),
      },
    },
  },
});
