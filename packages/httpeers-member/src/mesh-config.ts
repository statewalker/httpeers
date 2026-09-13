/**
 * The one place a `MeshConfig` is validated, whatever channel it arrived on.
 *
 * Two channels exist and both used to check differently: `mesh-memory.ts`
 * validated what it read from storage, and `session.ts` CAST what it fetched
 * over HTTP (`return (await res.json()) as HttpeersConfig`). A cast checks
 * nothing, and the gap showed up as soon as the hub moved into a tab: a
 * hub-page deployment has no stable `hubPeerId` to publish, so its
 * `httpeers.json` carries `relayAddrs` alone, and that config reached
 * `startMember` with `hubPeerId: undefined` — failing far from the cause.
 *
 * `null` FOR ANYTHING UNUSABLE, never a throw. The session already renders
 * `null` correctly ("no mesh to join — paste an invitation"), which is exactly
 * the state a hub-page deployment starts every other page in. Throwing would
 * take out the page, including the invitation field that fixes it.
 */

import type { MeshConfig } from "@statewalker/httpeers-core";

/**
 * A usable `MeshConfig`, or `null`.
 *
 * Returns a FRESH object carrying only the two known fields: a deployment may
 * publish more, and passing unknown keys through would let an unrelated one
 * look like configuration this library honours.
 */
export function parseMeshConfig(value: unknown): MeshConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { relayAddrs, hubPeerId } = value as Partial<MeshConfig>;

  // A relay list that is empty is not a mesh: `startMember` reads
  // `relayAddrs[0]` and has nothing to dial.
  if (!Array.isArray(relayAddrs) || relayAddrs.length === 0) return null;
  if (!relayAddrs.every((addr) => typeof addr === "string" && addr !== "")) return null;

  // The hub's peerId IS the mesh's name — every token's `mesh` claim restates
  // it — so a config without one names no mesh at all.
  if (typeof hubPeerId !== "string" || hubPeerId === "") return null;

  return { relayAddrs, hubPeerId };
}
