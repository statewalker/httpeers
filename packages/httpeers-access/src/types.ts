/**
 * The vocabulary this package adds to core's.
 *
 * `MeshId` is a peerId string used as a mesh identity — the hub's. It is a
 * distinct name from `PeerIdStr` because the two are used for different jobs
 * and confusing them is how a member's id ends up where an issuer's belongs.
 */

export type { PeerIdStr } from "@statewalker/httpeers-core";

/** A mesh's identity: the hub's peerId, which is also its verifying key. */
export type MeshId = string;

/** Whom a token is about. */
export type SubjectId = string;
