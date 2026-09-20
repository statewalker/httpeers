/**
 * The worker, as ONE classic script at a FIXED URL.
 *
 * Fixed, because a registration is keyed by the script's URL: a hashed name
 * would orphan the previous worker on every publish. Classic (IIFE), because a
 * module worker is not supported everywhere a session must work. And bundled
 * from real code rather than a side-effect-only import of the library's
 * worker, which `apps/demos` found bundles to a zero-byte file.
 */
import { join } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: join(process.cwd(), "dist", "site"),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: join(process.cwd(), "src", "sw.ts"),
      formats: ["iife"],
      name: "httpeersSessionWorker",
      fileName: () => "relay-sw.js",
    },
  },
});
