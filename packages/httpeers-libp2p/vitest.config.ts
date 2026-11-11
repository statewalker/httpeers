import { defineConfig } from "vitest/config";

/**
 * The transport tests run on both exchange paths (#56): one libp2p stream per
 * exchange (the default) and the experimental one mux per peer. The library
 * reads no environment: the projects set `HTTPEERS_LIBP2P_MUX_PER_PEER`, and
 * the tests read it (`tests/exchange-path-option.ts`) and pass `muxPerPeer`
 * down. `tests/exchange-path.test.ts` checks that each project really runs the
 * path it names; `tests/mux-link.test.ts` passes the option itself, so it runs
 * once, in `per-exchange`.
 */
const SWITCH = "HTTPEERS_LIBP2P_MUX_PER_PEER";

/** The files that build a transport and take the option from the project. */
const BOTH_PATHS = [
  "tests/exchange-path.test.ts",
  "tests/serve-peer.test.ts",
  "tests/peer-gone.test.ts",
  "tests/quiet-exchange.test.ts",
];

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
        test: { name: "mux-per-peer", include: BOTH_PATHS, env: { [SWITCH]: "1" } },
      },
    ],
  },
});
