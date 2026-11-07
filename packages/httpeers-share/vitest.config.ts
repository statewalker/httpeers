import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: the root entry claims to need no DOM.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // `*.e2e.test.ts` spawn other runtimes (bun, deno): `pnpm test:e2e`.
    exclude: [...configDefaults.exclude, ...(process.env.E2E ? [] : ["tests/**/*.e2e.test.ts"])],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
