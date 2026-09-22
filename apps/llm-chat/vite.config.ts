/**
 * A plain multi-page build: `index.html` (the standalone chat) and `mesh.html` (the chat over an
 * httpeers mesh). The two share chunks but not entries, and the boundary test keeps the standalone
 * closure free of httpeers.
 *
 * `public/sw.js` is copied, not built, by `scripts/copy-assets.mjs` (the `prebuild` step): the edge
 * registers the worker by URL, so it must stay at the origin root and un-hashed. Biscuit needs
 * nothing here — no wasm, no aliases, no optimizer exclusions.
 */

import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        mesh: resolve(import.meta.dirname, "mesh.html"),
      },
    },
  },
});
