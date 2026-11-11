/**
 * Which exchange path this run is on (#56), for the suite to pass down as
 * `muxPerPeer` wherever it builds a transport (the hub harness, `startMember`,
 * `createRemote`). The vitest projects (`vitest.config.ts`) set the variable;
 * no library reads it.
 */
export const MUX_PER_PEER_TEST_ENV = "HTTPEERS_LIBP2P_MUX_PER_PEER";

/** `true` in the `mux-per-peer` project, `false` in `per-exchange`. */
export const MUX_PER_PEER = process.env[MUX_PER_PEER_TEST_ENV] === "1";
