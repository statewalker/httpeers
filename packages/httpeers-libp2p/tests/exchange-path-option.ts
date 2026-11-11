/**
 * Which exchange path this test run is on (#56), for the tests to pass down as
 * `muxPerPeer`. The vitest projects (`vitest.config.ts`) set the variable; the
 * library itself never reads it -- the option is the only switch.
 */
export const MUX_PER_PEER_TEST_ENV = "HTTPEERS_LIBP2P_MUX_PER_PEER";

/** `true` in the `mux-per-peer` project, `false` in `per-exchange`. */
export const MUX_PER_PEER = process.env[MUX_PER_PEER_TEST_ENV] === "1";
