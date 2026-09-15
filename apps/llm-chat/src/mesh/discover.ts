/**
 * Finding the hub's LLM service and turning its OpenAPI document into a chat endpoint.
 *
 * PURE AND FETCH-INJECTED, so it runs under Node in the unit tests. It imports nothing from
 * httpeers: the mesh view is taken by shape, and every call is a plain `fetch` to a URL under the
 * page's edge base, which the ServiceWorker routes over the mesh.
 *
 * WHAT IS READ FROM THE DOCUMENT (spec §5.6), and nothing is hard-coded instead:
 *   - `servers[0].url`, resolved against the document's own URL (the hub publishes `"."`), is the
 *     service base; the OpenAI-compatible base is that plus `v1`;
 *   - `components.securitySchemes.llmKey.name` is the header the key travels in;
 *   - `paths["/ui/"].get["x-httpeers-entry"]`, resolved against the service base, is the dashboard;
 *   - `paths["/keys"]` existing is what offers "Request a key". The call may still be refused.
 */

import { applyEndpoint, type ChatConfig } from "../core/config.js";

export const LLM_ADVERT_ID = "llm";
export const LLM_ADVERT_KIND = "openapi-service";

export interface LlmService {
  /** The service mount, with a trailing slash: `<edge><hubPeerId>/llm/`. */
  serviceBase: string;
  /** The OpenAI-compatible base, no trailing slash: `<serviceBase>v1`. */
  baseUrl: string;
  apiKeyHeader: string;
  canMintKeys: boolean;
  dashboardUrl: string;
}

/** The parts of `MeshView` read here, by shape. */
export interface MeshViewLike {
  self: string;
  members: ReadonlyArray<{ peerId: string; roles: readonly string[] }>;
  advertisements: ReadonlyArray<{ peerId: string; id: string; kind: string }>;
}

interface OpenApiDocument {
  servers?: Array<{ url?: unknown }>;
  components?: { securitySchemes?: Record<string, { name?: unknown } | undefined> };
  paths?: Record<string, Record<string, Record<string, unknown> | undefined> | undefined>;
}

export class DiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscoveryError";
  }
}

/** The hub's `llm` service advert, if this mesh has one. */
export function findLlmAdvert(
  view: Pick<MeshViewLike, "advertisements"> | null,
): MeshViewLike["advertisements"][number] | undefined {
  return view?.advertisements.find((ad) => ad.id === LLM_ADVERT_ID && ad.kind === LLM_ADVERT_KIND);
}

/**
 * Whether this member's own entry in the mesh view carries the `admin` role.
 *
 * A HINT FOR WHAT TO SHOW, NEVER A GATE: the hub decides every call by its rules. It costs no
 * request, and the hub's rules grant `app:llm.admin` to `role("admin")` (spec §5.3). If a hub maps
 * roles differently the dashboard link is merely missing or refused, which is harmless.
 */
export function isMeshAdmin(view: Pick<MeshViewLike, "self" | "members"> | null): boolean {
  if (view == null) return false;
  return view.members.find((m) => m.peerId === view.self)?.roles.includes("admin") ?? false;
}

export async function discoverLlm(
  fetchImpl: typeof fetch,
  edgeBase: string,
  hubPeerId: string,
): Promise<LlmService> {
  const edge = edgeBase.endsWith("/") ? edgeBase : `${edgeBase}/`;
  const docUrl = new URL(`${hubPeerId}/${LLM_ADVERT_ID}/openapi.json`, edge);

  let response: Response;
  try {
    response = await fetchImpl(docUrl.href, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new DiscoveryError(`Could not reach the LLM service at ${docUrl.href}.`, { cause });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DiscoveryError(
      `The LLM service document answered HTTP ${response.status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`,
    );
  }
  const doc = (await response.json()) as OpenApiDocument;

  const server = doc.servers?.[0]?.url;
  if (typeof server !== "string" || server === "") {
    throw new DiscoveryError("The LLM service document has no servers[0].url.");
  }
  const service = new URL(server, docUrl);
  if (!service.pathname.endsWith("/")) service.pathname += "/";

  const header = doc.components?.securitySchemes?.llmKey?.name;
  if (typeof header !== "string" || header === "") {
    throw new DiscoveryError(
      "The LLM service document has no llmKey security scheme naming the key header.",
    );
  }

  const entry = doc.paths?.["/ui/"]?.get?.["x-httpeers-entry"];
  return {
    serviceBase: service.href,
    baseUrl: new URL("v1", service).href,
    apiKeyHeader: header.toLowerCase(),
    canMintKeys: doc.paths?.["/keys"] != null,
    dashboardUrl: new URL(typeof entry === "string" ? entry : "ui/", service).href,
  };
}

/** A refused or failed `POST keys`. `status` 403 means this member may not mint keys. */
export class KeyRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KeyRequestError";
  }
}

/**
 * Ask the hub to mint a LiteLLM key (spec §5.2). The hub uses its own master key; this request
 * carries no key and no `Authorization`, so the edge attaches the mesh token that authorizes it.
 *
 * The alias carries the full timestamp, not just the day: LiteLLM refuses a duplicate key alias.
 */
export async function mintKey(
  fetchImpl: typeof fetch,
  serviceBase: string,
  now: Date = new Date(),
): Promise<string> {
  const response = await fetchImpl(new URL("keys", serviceBase).href, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key_alias: `mesh-chat-${now.toISOString()}` }),
  });
  if (response.status === 403) {
    throw new KeyRequestError(
      403,
      "The hub refused (403): only a mesh admin can request a key. Ask an admin for one and paste it.",
    );
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new KeyRequestError(
      response.status,
      `The key request failed: HTTP ${response.status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`,
    );
  }
  let key: unknown;
  try {
    key = (JSON.parse(body) as { key?: unknown }).key;
  } catch {
    key = undefined;
  }
  if (typeof key !== "string" || key === "") {
    throw new KeyRequestError(response.status, "The hub answered with no key.");
  }
  return key;
}

/**
 * The config to store after discovery: the discovered endpoint and header, keeping whatever key
 * is already stored. The same endpoint keeps its models; a different one (another hub) clears them.
 */
export function meshConfig(
  previous: ChatConfig | null,
  service: Pick<LlmService, "baseUrl" | "apiKeyHeader">,
): ChatConfig {
  return applyEndpoint(previous, {
    baseUrl: service.baseUrl,
    apiKey: previous?.apiKey ?? "",
    apiKeyHeader: service.apiKeyHeader,
  });
}
