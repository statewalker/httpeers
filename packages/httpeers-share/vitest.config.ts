import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: the root entry claims to need no DOM.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
