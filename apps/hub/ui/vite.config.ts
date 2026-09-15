/**
 * Builds `ui/` (plain DOM TypeScript, no framework) to `../dist-ui`, which
 * `local-door.ts` serves at `/` by default. No ServiceWorker copy step, unlike
 * `apps/demos`: this page only calls `/hub/api/*` over `fetch` and never
 * touches a token itself.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  build: {
    outDir: join(here, "..", "dist-ui"),
    emptyOutDir: true,
  },
});
