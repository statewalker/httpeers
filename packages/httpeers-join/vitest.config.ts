import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // happy-dom for the widget itself. `tests/import.test.ts` opts back into
    // plain Node with a per-file pragma, because "importing needs no DOM" is a
    // claim that can only be tested where there is none.
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
  },
});
