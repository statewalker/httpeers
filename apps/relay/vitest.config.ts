import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests bind real ports and start real libp2p nodes.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
