import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: a package that claims to need no DOM must not be tested
    // in an environment that provides one, or the claim is never exercised.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
