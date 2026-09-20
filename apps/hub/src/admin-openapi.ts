/**
 * `GET /hub/api/openapi.json` — the admin API's own self-description, so an
 * operator (or the local UI, Task 6) can find every route without reading
 * this source.
 *
 * A PLAIN OBJECT, NOT A GENERATOR OVER LIVE STATE. The route table is spec
 * §5.4 and does not change per hub instance -- `services` and `roles` are
 * per-hub values already exposed by `GET /hub/api/mesh` and
 * `GET /hub/api/roles`, not something this document should re-derive and risk
 * drifting from those endpoints' own answers.
 */

/** Loose enough to describe OpenAPI 3.1 without pulling in a schema package. */
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

const jsonResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { "application/json": { schema } },
});

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
};
const errorResponse = (description: string) => jsonResponse(description, errorSchema);

const memberSchema = {
  type: "object",
  required: ["peerId", "roles", "online", "addrs"],
  properties: {
    peerId: { type: "string" },
    roles: { type: "array", items: { type: "string" } },
    online: { type: "boolean" },
    addrs: { type: "array", items: { type: "string" } },
  },
};

/** `GET /hub/api/members`' item: the mesh view's member plus the hub's own view of the link. */
const memberWithLinkSchema = {
  type: "object",
  required: [...memberSchema.required, "link"],
  properties: {
    ...memberSchema.properties,
    link: {
      enum: ["direct", "relay", null],
      description:
        "How the member reaches the hub now, from the hub's open connections to it: " +
        '"direct" if any is unlimited (WebRTC), "relay" if only relay circuits are open, null if none.',
    },
  },
};

const invitationSchema = {
  type: "object",
  required: ["id", "roles", "expiresAt"],
  properties: {
    id: { type: "string" },
    roles: { type: "array", items: { type: "string" } },
    expiresAt: { type: "number" },
  },
};

/**
 * The relay supervisor's view (`superviseRelay(...).state()`) plus the hub's
 * verdict on it. `healthy` is the one field a healthcheck needs; everything
 * else is for a person reading the page.
 */
const relaySchema = {
  type: "object",
  required: ["status", "relayAddr", "relayPeerId", "healthy"],
  properties: {
    status: {
      enum: ["reserved", "lost", "stopped"],
      description:
        "As the RELAY last answered, not as the node's own address list believes -- " +
        "the two disagreed for hours during the 2026-09-19 incident.",
    },
    relayAddr: { type: "string" },
    relayPeerId: { type: ["string", "null"] },
    verifiedAt: { type: ["number", "null"], description: "When the relay last confirmed it." },
    expiresAt: { type: ["number", "null"], description: "When the relay says it expires." },
    lostSince: { type: ["number", "null"], description: "When the loss was first noticed." },
    consecutiveFailures: { type: "number" },
    renewals: { type: "number" },
    restores: { type: "number" },
    lastError: { type: ["string", "null"] },
    healthy: {
      type: "boolean",
      description: "Reserved, or lost for less than the grace period (two minutes).",
    },
  },
};

/** Build the admin API's OpenAPI 3.1 document. */
export function buildAdminOpenApi(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Hub admin API", version: "1.0.0" },
    servers: [{ url: "." }],
    paths: {
      "/hub/api/mesh": {
        get: {
          operationId: "getMesh",
          summary: "The mesh view, plus this hub's own identity and services.",
          responses: {
            "200": jsonResponse("The mesh view", {
              type: "object",
              required: [
                "version",
                "self",
                "members",
                "advertisements",
                "hubPeerId",
                "relayAddrs",
                "services",
              ],
              properties: {
                version: { type: "number" },
                self: { type: "string" },
                members: { type: "array", items: memberSchema },
                advertisements: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      peerId: { type: "string" },
                      id: { type: "string" },
                      kind: { type: "string" },
                      title: { type: "string" },
                    },
                  },
                },
                hubPeerId: { type: "string" },
                relayAddrs: { type: "array", items: { type: "string" } },
                services: { type: "array", items: { type: "string" } },
                relay: relaySchema,
              },
            }),
          },
        },
      },
      "/hub/api/relay": {
        get: {
          operationId: "getRelay",
          summary: "This hub's circuit-relay reservation, as the relay itself last answered.",
          responses: { "200": jsonResponse("The reservation's state", relaySchema) },
        },
      },
      "/hub/api/health": {
        get: {
          operationId: "getHealth",
          summary:
            "Whether this hub is reachable through its relay. 503 once the reservation has " +
            "been lost for longer than the grace period.",
          responses: {
            "200": jsonResponse("Healthy", {
              type: "object",
              required: ["ok", "relay"],
              properties: { ok: { const: true }, relay: relaySchema },
            }),
            "503": jsonResponse("Unreachable through the relay", {
              type: "object",
              required: ["ok", "relay"],
              properties: { ok: { const: false }, relay: relaySchema },
            }),
          },
        },
      },
      "/hub/api/roles": {
        get: {
          operationId: "getRoles",
          summary: "Every role name this hub's rules know.",
          responses: {
            "200": jsonResponse("Role names", { type: "array", items: { type: "string" } }),
          },
        },
      },
      "/hub/api/invitations": {
        get: {
          operationId: "listInvitations",
          summary: "Invitations not yet redeemed or expired.",
          responses: {
            "200": jsonResponse("Pending invitations", {
              type: "array",
              items: invitationSchema,
            }),
          },
        },
        post: {
          operationId: "createInvitation",
          summary: "Mint an invitation, and the link and QR-ready blob that carry it.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["roles"],
                  properties: {
                    roles: { type: "array", items: { type: "string" } },
                    ttlMs: { type: "number", description: "Default 24h." },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("The minted invitation", {
              type: "object",
              required: ["id", "expiresAt", "blob", "link"],
              properties: {
                id: { type: "string" },
                expiresAt: { type: "number" },
                blob: { type: "string" },
                link: { type: "string" },
              },
            }),
            "400": errorResponse("Malformed body, or a role no rule of this hub knows."),
          },
        },
      },
      "/hub/api/members": {
        get: {
          operationId: "listMembers",
          summary: "Every member, with roles, online state and its current link to the hub.",
          responses: {
            "200": jsonResponse("Members", { type: "array", items: memberWithLinkSchema }),
          },
        },
      },
      "/hub/api/members/{peerId}": {
        delete: {
          operationId: "removeMember",
          summary: "Remove a member and revoke its tokens.",
          parameters: [{ name: "peerId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": jsonResponse("Removed", {
              type: "object",
              required: ["ok", "removed"],
              properties: { ok: { type: "boolean" }, removed: { type: "string" } },
            }),
            "404": errorResponse("No such member."),
          },
        },
      },
      "/hub/api/openapi.json": {
        get: {
          operationId: "getOpenApi",
          summary: "This document.",
          responses: { "200": jsonResponse("This OpenAPI document", { type: "object" }) },
        },
      },
    },
  };
}
