/**
 * `DELETE /admin/members/{peerId}` — closes the gap the design record has
 * carried since Task 1: `MemberStore.remove` has existed as a store method
 * with no endpoint and no authorisation the whole time, "exactly the kind
 * of thing that must not be reachable by an ordinary member" (design
 * record §5.2). Capability gating (`std:mesh.admin`) is `policy.ts`'s
 * `/admin` policy in `policy.ts`, not this handler's job — this file only
 * does the removal, same split as every other handler in this app.
 *
 * TWO CALLS, NOT ONE, BECAUSE THIS PACKAGE SPLIT WHAT THE ARCHIVE KEPT AS
 * ONE STORE. `hub.memberStore.remove(peerId)` drops membership;
 * `hub.revocations.revoke(peerId)` records the change so a provider's
 * pulled deny-list cache can see it — see `tests/support/mesh.ts`'s own
 * header comment for the archived one-call precedent this splits in two.
 * `RevocationRegistry.revoke` bumps `policyVersion()` internally (see
 * `revocation.ts`): there is no separate "bump the version" step to
 * forget — calling `revoke` at all IS the bump, which is what makes a
 * provider's next heartbeat see the change.
 *
 * Removal (and revocation) is unconditional and idempotent: `MemberStore
 * .remove` on a peerId that is not currently a member is a harmless no-op
 * (`Map.delete` on a missing key), and revoking a peerId with no prior
 * membership is a legitimate "make sure this identity can never redeem an
 * old token" operation, not an error condition — so this handler does not
 * 404 on an unknown peerId.
 */
import type { FetchHandler, MemberStore } from "@statewalker/httpeers-core";
import type { RevocationRegistry } from "@statewalker/httpeers-access/issuer";
import { json } from "@statewalker/httpeers-core";
import { Hono } from "hono";

export interface AdminEndpointsInit {
  memberStore: MemberStore;
  revocations: RevocationRegistry;
}

/** `DELETE /admin/members/{peerId}`. Mounted at `/admin/members` — see `hub/endpoints.ts`. */
export function createAdminEndpoints(init: AdminEndpointsInit): FetchHandler {
  const app = new Hono();

  app.delete("/admin/members/:peerId", (c) => {
    const peerId = c.req.param("peerId");
    init.memberStore.remove(peerId);
    init.revocations.revoke(peerId);
    return json({ ok: true, removed: peerId, policyVersion: init.revocations.policyVersion() });
  });

  return app.fetch as FetchHandler;
}
