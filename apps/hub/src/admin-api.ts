/**
 * The hub's admin REST API — spec §5.4. ONE HANDLER, TWO WAYS IN, same shape
 * as a service module (`service-module.ts`'s header comment): the mesh mount
 * `/hub` (behind `withAccess`, capability `std:mesh.admin`, wired in
 * `daemon.ts`) and the local door's `/hub/api/*` (no access layer at all —
 * `local-door.ts` calls this directly).
 *
 * NEITHER CALLER STRIPS A PREFIX. The mesh router hands an `extraMounts` entry
 * the full path (`/hub/api/...`, see `httpeers-core`'s router comment quoted
 * in the integration map); the local door forwards to its `adminApi` with the
 * same path shape it received (`local-door.ts`). So this parses
 * `/hub/api/...` itself, exactly like `createLocalDoorHandler` parses its own
 * routes.
 *
 * EVERY BODY SHAPE IS THE ROUTE TABLE'S, LITERALLY. Where the spec says a
 * route returns "X plus Y" or "pending invitations", the response body IS
 * that value — no envelope invented on top — except where the spec spells
 * out the envelope itself (`POST /hub/api/invitations`'s `{ id, expiresAt,
 * blob, link }`). `DELETE /hub/api/members/:peerId` has no body shape in the
 * spec table, so it returns `{ ok, removed }`, the same shape the mesh's own
 * internal `/admin/members/:peerId` already returns (`httpeers-hub/admin.ts`).
 */

import type { RuleSet } from "@statewalker/httpeers-access";
import { roleNames, validateRoles } from "@statewalker/httpeers-access";
import type { Hub } from "@statewalker/httpeers-hub";
import {
  RESERVATION_LOSS_GRACE_MS,
  type RelayReservationState,
  reservationHealthy,
} from "@statewalker/httpeers-libp2p";
import { encodeJoinBlob, type JoinBlob, joinUrl } from "@statewalker/httpeers-member";
import { buildAdminOpenApi } from "./admin-openapi.js";
import type { MemberLink } from "./member-link.js";

export const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What `GET /hub/api/relay` answers, and what `GET /hub/api/mesh` carries
 * under `relay`: the supervisor's own state plus the one derived bit an
 * operator (or a container healthcheck) actually acts on.
 */
export type RelayReport = RelayReservationState & { healthy: boolean };

export interface AdminApiInit {
  hub: Hub;
  hubPeerId: string;
  relayAddrs: string[];
  /** `HubConfig.joinPageUrl` — the page an invitation link opens. */
  joinPageUrl: string;
  rules: RuleSet;
  /** Enabled module ids — `GET /hub/api/mesh`'s `services`. */
  services: string[];
  /** `GET /hub/api/members`'s per-member `link`, from the hub's live connections (`member-link.ts`). */
  linkOf(peerId: string): MemberLink;
  /**
   * The relay supervisor's view -- `superviseRelay(...).state()`, read fresh
   * on every request rather than captured, so a route never answers from a
   * snapshot taken when the daemon started.
   */
  relayState(): RelayReservationState;
  /** How long a lost reservation may go unrepaired before the hub calls itself unhealthy. */
  relayLossGraceMs?: number;
  now?: () => number;
  /**
   * Remove and revoke a member, durably. What this calls does the whole job
   * — `memberStore.remove` + `revocations.revoke` + awaiting the revocation
   * write — so this file never has to know any of that happened; see
   * `daemon.ts`'s wiring and its comment on `revocationsFlushed`.
   */
  revoke(subject: string): Promise<void>;
}

type Handler = (request: Request) => Promise<Response>;

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** `undefined` on anything that is not a single JSON object — never throws. */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (text.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The handler both mounts serve — see the module comment. */
export function createAdminApi(init: AdminApiInit): Handler {
  const openapi = buildAdminOpenApi();
  const now = init.now ?? Date.now;
  const graceMs = init.relayLossGraceMs ?? RESERVATION_LOSS_GRACE_MS;

  /**
   * THE RELAY REPORT IS COMPUTED PER REQUEST, never cached: `healthy` is a
   * function of how long ago the loss was, so a value computed once would go
   * stale in exactly the direction that matters -- reporting a hub healthy
   * for as long as nobody restarted it.
   */
  function relayReport(): RelayReport {
    const state = init.relayState();
    return { ...state, healthy: reservationHealthy(state, graceMs, now()) };
  }

  async function createInvitation(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    if (body == null || !isStringArray(body.roles)) {
      return errorResponse(400, "expected { roles: string[], ttlMs?: number }");
    }
    if (body.ttlMs !== undefined && (typeof body.ttlMs !== "number" || !(body.ttlMs > 0))) {
      return errorResponse(400, "ttlMs must be a positive number");
    }
    const problems = validateRoles(init.rules, body.roles, "invitation");
    if (problems.length > 0) return errorResponse(400, problems.join("; "));

    const ttlMs = body.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
    const { id, expiresAt } = await init.hub.invitations.create(body.roles, ttlMs);
    const joinBlob: JoinBlob = {
      relayAddrs: init.relayAddrs,
      hubPeerId: init.hubPeerId,
      invitationId: id,
    };
    return Response.json({
      id,
      expiresAt,
      blob: encodeJoinBlob(joinBlob),
      link: joinUrl(init.joinPageUrl, joinBlob),
    });
  }

  async function removeMember(peerId: string): Promise<Response> {
    if (init.hub.members.get(peerId) == null) {
      return errorResponse(404, `no such member "${peerId}"`);
    }
    await init.revoke(peerId);
    return Response.json({ ok: true, removed: peerId });
  }

  return async (request) => {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === "/hub/api/mesh" && method === "GET") {
      const view = init.hub.meshView();
      return Response.json({
        ...view,
        hubPeerId: init.hubPeerId,
        relayAddrs: init.relayAddrs,
        services: init.services,
        relay: relayReport(),
      });
    }

    // READ-ONLY, AND SEPARATE FROM `/hub/api/mesh`, because a container
    // healthcheck should not have to build and parse a whole mesh view -- and
    // because "is this hub reachable through the relay" is a different
    // question from "who is in the mesh", asked by different callers.
    if (pathname === "/hub/api/relay" && method === "GET") {
      return Response.json(relayReport());
    }

    /**
     * THE HUB'S OWN VERDICT ON ITSELF, and the reason this route exists at
     * all. The appliance's healthcheck used to ask for `/hub/api/mesh` and
     * accept any 200 -- which the hub answered happily throughout the
     * 2026-09-19 incident, while no member could reach it. A hub whose
     * reservation has been gone for longer than the grace period is NOT
     * healthy, and says so with a status code a healthcheck reads without
     * parsing anything.
     */
    if (pathname === "/hub/api/health" && method === "GET") {
      const relay = relayReport();
      return Response.json({ ok: relay.healthy, relay }, { status: relay.healthy ? 200 : 503 });
    }

    if (pathname === "/hub/api/roles" && method === "GET") {
      return Response.json(roleNames(init.rules));
    }

    if (pathname === "/hub/api/invitations") {
      if (method === "POST") return createInvitation(request);
      if (method === "GET") return Response.json(init.hub.invitations.pending());
    }

    if (pathname === "/hub/api/members" && method === "GET") {
      return Response.json(
        init.hub.meshView().members.map((member) => ({
          ...member,
          link: init.linkOf(member.peerId),
        })),
      );
    }

    if (pathname.startsWith("/hub/api/members/") && method === "DELETE") {
      const raw = pathname.slice("/hub/api/members/".length);
      let peerId: string;
      try {
        peerId = decodeURIComponent(raw);
      } catch {
        return errorResponse(400, `malformed peerId in path: "${raw}"`);
      }
      if (peerId !== "" && !peerId.includes("/")) return removeMember(peerId);
    }

    if (pathname === "/hub/api/openapi.json" && method === "GET") {
      return Response.json(openapi);
    }

    return errorResponse(404, `not found: ${method} ${pathname}`);
  };
}
