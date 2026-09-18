/**
 * Inviting from the widget: the hub's admin REST API, called over the mesh.
 *
 * NO DOM HERE, so every decision the Invite panel makes -- who counts as an
 * admin, which roles are offered, what a request body carries, how long an
 * invitation lives -- is a plain function a test calls with a fake `fetch`.
 * `./invite-panel.ts` is the DOM on top.
 *
 * THE SAME PATH A PAGE ALREADY USES TO REACH THE HUB. A page's ServiceWorker
 * edge routes `<baseUrl><hubPeerId>/...` over the mesh with this member's
 * token attached (llm-chat's `mesh.html` requests an LLM key exactly this
 * way), and the hub serves its admin API at `/hub/api/*` behind
 * `std:mesh.admin` (`apps/hub/src/rules.ts`, `CORE_POLICIES`). So:
 *
 *   - `GET  /hub/api/roles`       -> role names; a 403 means "not an admin".
 *   - `POST /hub/api/invitations` -> `{ id, expiresAt, blob, link }`.
 *   - `GET  /hub/api/invitations` -> the pending ones, `{ id, roles, expiresAt }[]`.
 *
 * THE ROLES CALL IS THE ADMIN CHECK. The mesh view's own roles are a hint
 * only (`adminHint`: it decides whether to ask, so a member's console is not
 * sprayed with 403s); the hub's policy is the answer, and asking the hub costs
 * one request per link. A hub that is a browser tab (the demos) has no `/hub/api` at all
 * and answers 404, which hides the panel the same way.
 *
 * AN INVITATION IS A BEARER SECRET. Nothing here logs one, and no error
 * message quotes a response body that could carry one: the only body read on
 * failure is the hub's `{ error }`, which never includes an invitation.
 */

/** The roles the panel offers, in order. Anything else a hub knows (`hidden`, a module's own) is not offered. */
export const INVITE_ROLES = ["member", "admin"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const DEFAULT_INVITE_ROLE: InviteRole = "member";

const HOUR = 60 * 60 * 1000;

/** The lifetimes offered. The hub's own default is one day, and so is the panel's. */
export const INVITE_EXPIRIES = [
  { id: "1h", label: "1 hour", ttlMs: HOUR },
  { id: "1d", label: "1 day", ttlMs: 24 * HOUR },
  { id: "7d", label: "7 days", ttlMs: 7 * 24 * HOUR },
] as const;
export type InviteExpiryId = (typeof INVITE_EXPIRIES)[number]["id"];

export const DEFAULT_INVITE_EXPIRY: InviteExpiryId = "1d";

/** What an admin invitation hands over, said before one is made. */
export const ADMIN_INVITATION_WARNING =
  "An admin invitation grants full control of this mesh: whoever redeems it can invite " +
  "others (admins too), revoke members, and use every admin service the hub offers. " +
  "Send it only to someone you would trust with this device.";

/** A lifetime id to milliseconds. An unknown id is the default, never `undefined`: the request always says how long. */
export function expiryMs(id: string): number {
  const found =
    INVITE_EXPIRIES.find((e) => e.id === id) ??
    INVITE_EXPIRIES.find((e) => e.id === DEFAULT_INVITE_EXPIRY);
  return (found as (typeof INVITE_EXPIRIES)[number]).ttlMs;
}

/** The body of `POST /hub/api/invitations`: one role, and the lifetime. */
export function invitationRequestBody(
  role: InviteRole,
  ttlMs: number,
): { roles: string[]; ttlMs: number } {
  return { roles: [role], ttlMs };
}

/** The roles to offer, given what the hub says it knows: ours, in our order, and only those it knows. */
export function offeredRoles(hubRoles: readonly string[]): InviteRole[] {
  return INVITE_ROLES.filter((role) => hubRoles.includes(role));
}

/** The part of a mesh view the admin hint reads, by shape. */
export interface MeshViewHint {
  self: string;
  members: ReadonlyArray<{ peerId: string; roles: readonly string[] }>;
}

/**
 * The part of a member handle the panel needs. `baseUrl` is absent where no
 * edge is mounted (Node). `meshView`, when present, is the hint that decides
 * whether the hub is asked at all -- see `adminHint`.
 */
export interface HubTarget {
  hubPeerId: string;
  baseUrl?: string;
  meshView?: () => MeshViewHint | null;
}

/**
 * Whether to ask the hub if this member is an admin: `true` when the mesh
 * view lists this member with the `admin` role, `false` when it lists it
 * without, `undefined` while there is no view yet (it arrives on the first
 * heartbeat). A target with no `meshView` at all is always asked.
 *
 * WHY ASK ONLY A LIKELY ADMIN. The hub's 403 is the answer, but a browser
 * reports every refused request in the console as an error, so asking every
 * member would put a red line in every member's console on every link. The
 * view says who holds `admin`, and the hub still decides: a view that says
 * `admin` to a peer the hub refuses leaves the panel hidden.
 */
export function adminHint(target: HubTarget | null | undefined): boolean | undefined {
  if (target == null) return false;
  if (typeof target.meshView !== "function") return true;
  const view = target.meshView();
  if (view == null) return undefined;
  return view.members.find((m) => m.peerId === view.self)?.roles.includes("admin") ?? false;
}

/** `<baseUrl><hubPeerId>/hub/api/`, or `null` when there is no edge to call through. */
export function hubAdminBase(target: HubTarget | null | undefined): string | null {
  if (target?.baseUrl == null || target.baseUrl === "") return null;
  if (!/^[A-Za-z0-9]+$/.test(target.hubPeerId)) return null;
  const base = target.baseUrl.endsWith("/") ? target.baseUrl : `${target.baseUrl}/`;
  return `${base}${target.hubPeerId}/hub/api/`;
}

export interface CreatedInvitation {
  id: string;
  expiresAt: number;
  blob: string;
  link: string;
}

export interface PendingInvitation {
  id: string;
  roles: string[];
  expiresAt: number;
}

/** A failed admin call. `status` is 0 when the request never got an answer. */
export class HubAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HubAdminError";
  }
}

/**
 * Whether a failed roles call means "this member is not an admin here" (or
 * "this hub has no admin API"), as opposed to a hiccup worth another try.
 */
export function isFinalRefusal(error: unknown): boolean {
  return (
    error instanceof HubAdminError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export interface HubAdminClient {
  /** The hub's role names. Rejects with a `HubAdminError`; a 403 is the usual "not an admin". */
  roles(): Promise<string[]>;
  create(role: InviteRole, ttlMs: number): Promise<CreatedInvitation>;
  pending(): Promise<PendingInvitation[]>;
}

async function failure(response: Response, what: string): Promise<HubAdminError> {
  let reason = "";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") reason = body.error.slice(0, 200);
  } catch {
    // Not JSON: say the status only. A body we do not understand is not quoted.
  }
  const status = response.status;
  const text =
    status === 403
      ? `The hub refused to ${what} (403): only a mesh admin can.`
      : `Could not ${what}: HTTP ${status}${reason === "" ? "" : ` (${reason})`}.`;
  return new HubAdminError(status, text);
}

/** The admin API at `apiBase` (`hubAdminBase`'s value), through `fetchImpl`. */
export function createHubAdminClient(fetchImpl: typeof fetch, apiBase: string): HubAdminClient {
  const call = async (path: string, what: string, init?: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, apiBase).href, {
        ...init,
        headers: { accept: "application/json", ...(init?.headers ?? {}) },
      });
    } catch (cause) {
      throw new HubAdminError(0, `Could not reach the hub to ${what}.`, { cause });
    }
    if (!response.ok) throw await failure(response, what);
    try {
      return await response.json();
    } catch (cause) {
      throw new HubAdminError(response.status, `The hub's answer to ${what} was not JSON.`, {
        cause,
      });
    }
  };

  return {
    async roles() {
      const value = await call("roles", "list its roles");
      if (!Array.isArray(value) || !value.every((r) => typeof r === "string")) {
        throw new HubAdminError(200, "The hub's role list is not a list of names.");
      }
      return value as string[];
    },
    async create(role, ttlMs) {
      const value = (await call("invitations", "create an invitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invitationRequestBody(role, ttlMs)),
      })) as Partial<CreatedInvitation> | null;
      if (
        value == null ||
        typeof value.link !== "string" ||
        value.link === "" ||
        typeof value.expiresAt !== "number"
      ) {
        throw new HubAdminError(200, "The hub answered without an invitation link.");
      }
      return value as CreatedInvitation;
    },
    async pending() {
      const value = await call("invitations", "list pending invitations");
      if (!Array.isArray(value)) {
        throw new HubAdminError(200, "The hub's pending invitations are not a list.");
      }
      return value.filter(
        (v): v is PendingInvitation =>
          v != null &&
          typeof v === "object" &&
          Array.isArray((v as PendingInvitation).roles) &&
          typeof (v as PendingInvitation).expiresAt === "number",
      );
    },
  };
}

/** "in 59 min", "in 23 h", "in 6 d", or "expired": how long an invitation has left, at a glance. */
export function describeExpiry(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(left / HOUR);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(left / (24 * HOUR))} d`;
}
