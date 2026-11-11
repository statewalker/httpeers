import { defineConfig } from "vitest/config";

/**
 * The whole suite runs on both exchange paths (#56): one libp2p stream per
 * exchange (the default) and the experimental one-mux-per-peer path. The
 * transport reads `HTTPEERS_LIBP2P_MUX_PER_PEER` wherever no `muxPerPeer`
 * option is passed, which is everywhere in the layers this suite builds
 * through (hub, member, relay).
 */
const SWITCH = "HTTPEERS_LIBP2P_MUX_PER_PEER";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "per-exchange", include: ["tests/**/*.test.ts"], env: { [SWITCH]: "0" } },
      },
      {
        extends: true,
        test: { name: "mux-per-peer", include: ["tests/**/*.test.ts"], env: { [SWITCH]: "1" } },
      },
    ],
  },
});
