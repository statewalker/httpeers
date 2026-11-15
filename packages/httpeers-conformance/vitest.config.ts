import { defineConfig } from "vitest/config";

/**
 * The whole suite runs on both exchange paths (#56): one mux per peer (the
 * default: `mux-per-peer` passes no option) and one libp2p stream per exchange
 * (`per-exchange` passes `muxPerPeer: false`). The projects set
 * `HTTPEERS_LIBP2P_MUX_PER_PEER`; the suite reads it
 * (`tests/exchange-path-option.ts`) and passes `MUX_PER_PEER_OPTION` to every
 * transport it builds (the hub harness, `startMember`, `createRemote`). No library reads
 * it. `relay-fallback.test.ts` checks the protocol a call rides on each path.
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
