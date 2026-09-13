/**
 * The mesh view: a PROJECTION over the three registries (members, presence,
 * advertisements), not a fourth registry of its own. Nothing here is stored
 * — it is recomputed from the hub's live state on every read, filtered by
 * whoever is asking.
 *
 * THE HUB IS A BULLETIN BOARD, NEVER AN AUTHORITY. An advertisement says
 * "worth asking"; the provider it names still decides for itself whether to
 * answer. Nothing downstream may treat inclusion in this view as a grant —
 * that is what the membership token and each provider's own policy
 * are for.
 *
 * Two things vary by caller, both because different callers legitimately
 * see different views:
 *  - a member with role `hidden` is omitted from the view of anyone who does
 *    not themselves hold `std:mesh.admin` — this is the one consumer of the
 *    `hidden` role `DEFAULT_RULES` already knows;
 *  - an advertisement is omitted unless the caller holds the capability that
 *    gates its `kind` (`advertisementAccess`, hub-owned config — analogous
 *    to an allow policy, but for the bulletin board rather than a path).
 */
import type {
  Advertisement,
  MemberRecord,
  MeshView,
  MeshViewAdvertisement,
  MeshViewMember,
  PresenceRecord,
} from "@statewalker/httpeers-core";

// `MeshView` and its members moved to `httpeers-core`. The hub PRODUCES one
// and `httpeers-member` RETURNS one, and member must not depend on hub — so a
// type both consume belongs in the package both already import. Re-exported
// here so this file's own readers still find it where they expect.
export type { MeshView, MeshViewAdvertisement, MeshViewMember };

/** The payload shape this hub posts advertisements with — see `hub/endpoints.ts`'s presence handler. */
export interface AdvertisementPayload {
  kind: string;
  title: string;
}

export interface BuildMeshViewInit {
  version: number;
  self: string;
  members: MemberRecord[];
  presence: PresenceRecord[];
  addrsByPeer: ReadonlyMap<string, string[]>;
  advertisements: Advertisement[];
  /** Capabilities the caller holds (already derived from their roles by the node's rules). */
  callerCapabilities: ReadonlySet<string>;
  /** `kind` -> capability required to see advertisements of that kind. A kind absent here is visible to any authenticated caller. */
  advertisementAccess: Readonly<Record<string, string>>;
  /** The capability that grants admin visibility (sees `hidden` members). */
  adminCapability: string;
}

export function buildMeshView(init: BuildMeshViewInit): MeshView {
  const isAdmin = init.callerCapabilities.has(init.adminCapability);
  const present = new Set(init.presence.map((p) => p.peerId));

  const members: MeshViewMember[] = init.members
    .filter((m) => isAdmin || !m.roles.includes("hidden"))
    .map((m) => ({
      peerId: m.peerId,
      roles: m.roles,
      online: present.has(m.peerId),
      addrs: init.addrsByPeer.get(m.peerId) ?? [],
    }));

  const advertisements: MeshViewAdvertisement[] = init.advertisements
    .filter((ad) => {
      const kind = (ad.payload as AdvertisementPayload).kind;
      const required = init.advertisementAccess[kind];
      return required == null || init.callerCapabilities.has(required);
    })
    .map((ad) => {
      const payload = ad.payload as AdvertisementPayload;
      return { peerId: ad.peerId, id: ad.key, kind: payload.kind, title: payload.title };
    });

  return { version: init.version, self: init.self, members, advertisements };
}
