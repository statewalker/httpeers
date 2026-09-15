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
import { encodeJoinBlob, type JoinBlob, joinUrl } from "@statewalker/httpeers-member";
import { buildAdminOpenApi } from "./admin-openapi.js";
import type { MemberLink } from "./member-link.js";

export const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

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
      });
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
