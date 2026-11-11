import { defineConfig } from "vitest/config";

/**
 * Every test runs on both exchange paths (#56): one libp2p stream per exchange
 * (the default) and the experimental one-mux-per-peer path, selected by the
 * `HTTPEERS_LIBP2P_MUX_PER_PEER` switch the transport reads when no option is
 * passed. `tests/exchange-path.test.ts` checks that each project really runs
 * the path it names; `tests/mux-link.test.ts` passes the option itself, so it
 * runs once.
 */
const SWITCH = "HTTPEERS_LIBP2P_MUX_PER_PEER";

export default defineConfig({
  test: {
    // Node, not jsdom: a package that claims to need no DOM must not be tested
    // in an environment that provides one, or the claim is never exercised.
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "per-exchange", include: ["tests/**/*.test.ts"], env: { [SWITCH]: "0" } },
      },
      {
        extends: true,
        test: {
          name: "mux-per-peer",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/mux-link.test.ts"],
          env: { [SWITCH]: "1" },
        },
      },
    ],
  },
});
