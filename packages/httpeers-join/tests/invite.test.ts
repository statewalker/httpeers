/**
 * The Invite panel: its pure decisions, its client, and the panel inside the
 * widget driven by a FAKE hub.
 *
 * The fake hub is a `fetch` that answers the three admin routes the way
 * `apps/hub/src/admin-api.ts` does, and records every request. What is
 * asserted is what an admin (or a member) would see and what the hub would
 * receive -- the panel's visibility, the request body, the link and QR on
 * screen, the inline error -- never the panel's internals.
 */

import type { SessionControls, SessionPhase } from "@statewalker/httpeers-member";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_INVITATION_WARNING,
  adminHint,
  createHubAdminClient,
  describeExpiry,
  expiryMs,
  HubAdminError,
  hubAdminBase,
  INVITE_EXPIRIES,
  type InvitePanelOptions,
  invitationRequestBody,
  isFinalRefusal,
  type JoinWidget,
  type JoinWidgetSession,
  type JoinWidgetState,
  type MeshViewHint,
  mountJoinWidget,
  offeredRoles,
} from "../src/index.js";

const PEER = "12D3KooWAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef";
const HUB = "12D3KooWHubHubHubHubHubHubHubHubHubHubHubHubHub1234";
const BASE = "https://page.example/peers/";
const API = `${BASE}${HUB}/hub/api/`;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

// --- pure ------------------------------------------------------------------

describe("the panel's decisions", () => {
  it("maps each expiry to its lifetime, and an unknown one to a day", () => {
    expect(INVITE_EXPIRIES.map((e) => [e.id, expiryMs(e.id)])).toEqual([
      ["1h", HOUR],
      ["1d", 24 * HOUR],
      ["7d", 7 * 24 * HOUR],
    ]);
    expect(expiryMs("forever")).toBe(24 * HOUR);
  });

  it("asks for exactly one role, member or admin, with the lifetime", () => {
    expect(invitationRequestBody("member", HOUR)).toEqual({ roles: ["member"], ttlMs: HOUR });
    expect(invitationRequestBody("admin", 7 * 24 * HOUR)).toEqual({
      roles: ["admin"],
      ttlMs: 7 * 24 * HOUR,
    });
  });

  it("offers member and admin, in that order, and only what the hub knows", () => {
    expect(offeredRoles(["admin", "hidden", "member"])).toEqual(["member", "admin"]);
    expect(offeredRoles(["member"])).toEqual(["member"]);
    expect(offeredRoles(["hidden", "operator"])).toEqual([]);
  });

  it("addresses the hub's admin API under the page's edge, or nowhere", () => {
    expect(hubAdminBase({ hubPeerId: HUB, baseUrl: BASE })).toBe(API);
    expect(hubAdminBase({ hubPeerId: HUB, baseUrl: "https://page.example/peers" })).toBe(API);
    expect(hubAdminBase({ hubPeerId: HUB })).toBeNull();
    expect(hubAdminBase({ hubPeerId: "../evil", baseUrl: BASE })).toBeNull();
    expect(hubAdminBase(null)).toBeNull();
  });

  it("says how long is left at a glance", () => {
    expect(describeExpiry(NOW + 59 * 60_000, NOW)).toBe("in 59 min");
    expect(describeExpiry(NOW + 23 * HOUR, NOW)).toBe("in 23 h");
    expect(describeExpiry(NOW + 7 * 24 * HOUR, NOW)).toBe("in 7 d");
    expect(describeExpiry(NOW - 1, NOW)).toBe("expired");
  });

  it("treats 401, 403 and 404 as final, everything else as worth another try", () => {
    for (const status of [401, 403, 404]) {
      expect(isFinalRefusal(new HubAdminError(status, "x"))).toBe(true);
    }
    for (const status of [0, 500, 502]) {
      expect(isFinalRefusal(new HubAdminError(status, "x"))).toBe(false);
    }
    expect(isFinalRefusal(new Error("x"))).toBe(false);
  });
});

// --- a fake hub --------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

interface FakeHubOptions {
  /** Status of `GET roles`, per call in order; the last repeats. 200 answers the role list. */
  roleStatuses?: number[];
  roles?: string[];
  createStatus?: number;
  createError?: string;
}

const LINK = (n: number) => `https://page.example/mesh.html?join=SECRET-BLOB-${n}`;

function fakeHub(opts: FakeHubOptions = {}) {
  const requests: Recorded[] = [];
  const pending: { id: string; roles: string[]; expiresAt: number }[] = [
    { id: "OLD-SECRET-ID", roles: ["member"], expiresAt: NOW + 3 * HOUR },
    { id: "GONE-SECRET-ID", roles: ["admin"], expiresAt: NOW - HOUR },
  ];
  const roleStatuses = [...(opts.roleStatuses ?? [200])];
  let created = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body == null ? undefined : JSON.parse(String(init.body));
    requests.push({ method, url, body });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url === `${API}roles` && method === "GET") {
      const status = roleStatuses.length > 1 ? (roleStatuses.shift() as number) : roleStatuses[0];
      if (status === 200) return json(opts.roles ?? ["admin", "hidden", "member"]);
      return json({ error: "forbidden" }, status);
    }
    if (url === `${API}invitations` && method === "POST") {
      if (opts.createStatus != null && opts.createStatus !== 200) {
        return json({ error: opts.createError ?? "nope" }, opts.createStatus);
      }
      created++;
      const record = {
        id: `NEW-SECRET-ID-${created}`,
        roles: body.roles,
        expiresAt: NOW + body.ttlMs,
      };
      pending.push(record);
      return json({ id: record.id, expiresAt: record.expiresAt, blob: "b", link: LINK(created) });
    }
    if (url === `${API}invitations` && method === "GET") return json(pending);
    return json({ error: "not found" }, 404);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, requests, pending };
}

describe("the admin client", () => {
  it("posts the role and lifetime, and returns the hub's link", async () => {
    const hub = fakeHub();
    const client = createHubAdminClient(hub.fetch, API);
    const made = await client.create("admin", HOUR);
    expect(made.link).toBe(LINK(1));
    expect(hub.requests.at(-1)).toEqual({
      method: "POST",
      url: `${API}invitations`,
      body: { roles: ["admin"], ttlMs: HOUR },
    });
  });

  it("turns a 403 into a HubAdminError that says only an admin can", async () => {
    const client = createHubAdminClient(fakeHub({ roleStatuses: [403] }).fetch, API);
    const err = await client.roles().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubAdminError);
    expect((err as HubAdminError).status).toBe(403);
    expect((err as Error).message).toMatch(/only a mesh admin/);
  });

  it("reports an unreachable hub as status 0", async () => {
    const client = createHubAdminClient(async () => {
      throw new TypeError("Failed to fetch");
    }, API);
    const err = (await client.roles().catch((e: unknown) => e)) as HubAdminError;
    expect(err.status).toBe(0);
    expect(isFinalRefusal(err)).toBe(false);
  });
});

// --- the panel, in the widget ------------------------------------------------

const LIVE_CONTROLS: SessionControls = {
  join: false,
  disconnect: true,
  reconnect: false,
  reset: true,
};

function live(handle: JoinWidgetState["handle"] = { hubPeerId: HUB, baseUrl: BASE }) {
  return {
    phase: { kind: "live", joinedBy: "resumed", note: null } as SessionPhase,
    identity: PEER,
    hubLink: "relay",
    controls: LIVE_CONTROLS,
    handle,
  } satisfies JoinWidgetState;
}

const disconnected: JoinWidgetState = {
  phase: { kind: "disconnected", message: "still a member" },
  identity: PEER,
  hubLink: null,
  controls: { join: false, disconnect: false, reconnect: true, reset: true },
  handle: null,
};

function fakeSession(): JoinWidgetSession {
  return {
    join: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    resetIdentity: vi.fn(async () => {}),
  };
}

let container: HTMLElement;
let widget: JoinWidget | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  widget?.destroy();
  widget = undefined;
  container.remove();
  document.getElementById("hp-join-style")?.remove();
});

const q = <T extends Element = HTMLElement>(selector: string): T | null =>
  container.querySelector<T>(selector);

function shown(selector: string): boolean {
  let node = q(selector);
  if (node == null) return false;
  while (node != null && node !== container) {
    if ((node as HTMLElement).hidden) return false;
    node = node.parentElement;
  }
  return true;
}

const text = (selector: string): string => q(selector)?.textContent?.trim() ?? "";

/** Let every pending promise (and a zero-delay retry) settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function mount(
  hub: ReturnType<typeof fakeHub>,
  invite: Partial<InvitePanelOptions> = {},
  extra: { compact?: boolean } = {},
): JoinWidget {
  widget = mountJoinWidget(container, {
    session: fakeSession(),
    scanner: null,
    compact: extra.compact,
    invite: {
      fetch: hub.fetch,
      share: null,
      qrSvg: (link) => `<svg data-test-link="${link.length}"></svg>`,
      now: () => NOW,
      retryDelayMs: 0,
      ...invite,
    },
  });
  return widget;
}

function choose(role: "member" | "admin"): void {
  const input = q<HTMLInputElement>(`.hp-invite-role-${role} input`);
  if (input == null) throw new Error(`no ${role} radio`);
  input.checked = true;
  input.dispatchEvent(new Event("change"));
}

async function create(): Promise<void> {
  q<HTMLButtonElement>(".hp-invite-create")?.click();
  await settle();
}

describe("the Invite panel", () => {
  it("shows for an admin once the hub lists its roles, and asks nothing until live", async () => {
    const hub = fakeHub();
    const w = mount(hub);
    w.update(disconnected);
    await settle();
    expect(hub.requests).toEqual([]);
    expect(shown(".hp-invite")).toBe(false);

    w.update(live());
    await settle();
    expect(hub.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${API}roles`]);
    expect(shown(".hp-invite")).toBe(true);
    // member and admin offered, member chosen, hidden not offered at all
    expect(shown(".hp-invite-role-member")).toBe(true);
    expect(shown(".hp-invite-role-admin")).toBe(true);
    expect(q<HTMLInputElement>(".hp-invite-role-member input")?.checked).toBe(true);
    expect(container.textContent).not.toMatch(/hidden/i);
    // default expiry: one day
    expect(q<HTMLSelectElement>(".hp-invite-expiry")?.value).toBe("1d");
  });

  it("stays hidden for a member the hub refuses (403), without asking again", async () => {
    const hub = fakeHub({ roleStatuses: [403] });
    const w = mount(hub);
    w.update(live());
    await settle();
    w.update(live()); // the page's 2 s re-render: same hub, no new question
    await settle();
    expect(shown(".hp-invite")).toBe(false);
    expect(hub.requests).toHaveLength(1);
  });

  it("stays hidden where the hub has no admin API (404) or the page has no edge", async () => {
    const hub = fakeHub({ roleStatuses: [404] });
    const w = mount(hub);
    w.update(live());
    await settle();
    expect(shown(".hp-invite")).toBe(false);
    w.update(disconnected);
    w.update(live({ hubPeerId: HUB }));
    await settle();
    expect(hub.requests).toHaveLength(1);
    expect(shown(".hp-invite")).toBe(false);
  });

  it("tries again after a hub hiccup (502), then shows", async () => {
    const hub = fakeHub({ roleStatuses: [502, 200] });
    const w = mount(hub);
    w.update(live());
    await settle();
    expect(hub.requests).toHaveLength(2);
    expect(shown(".hp-invite")).toBe(true);
  });

  it("is left out entirely with invite: false", async () => {
    widget = mountJoinWidget(container, { session: fakeSession(), scanner: null, invite: false });
    widget.update(live());
    await settle();
    expect(q(".hp-invite")).toBeNull();
  });

  it("creates a member invitation: one role, one day, link and QR on screen", async () => {
    const hub = fakeHub();
    const w = mount(hub);
    w.update(live());
    await settle();
    expect(shown(".hp-invite-warning")).toBe(false);
    await create();
    const post = hub.requests.find((r) => r.method === "POST");
    expect(post).toEqual({
      method: "POST",
      url: `${API}invitations`,
      body: { roles: ["member"], ttlMs: 24 * HOUR },
    });
    expect(shown(".hp-invite-result")).toBe(true);
    expect(q<HTMLInputElement>(".hp-invite-link")?.value).toBe(LINK(1));
    expect(q(".hp-invite-qr svg")?.getAttribute("data-test-link")).toBe(String(LINK(1).length));
    expect(text(".hp-invite-note")).toMatch(/joins as a member/);
  });

  it("creates an admin invitation, and warns before it does", async () => {
    const hub = fakeHub();
    const w = mount(hub);
    w.update(live());
    await settle();
    choose("admin");
    expect(shown(".hp-invite-warning")).toBe(true);
    expect(text(".hp-invite-warning")).toBe(ADMIN_INVITATION_WARNING);
    expect(ADMIN_INVITATION_WARNING).toMatch(/full control/);
    expect(ADMIN_INVITATION_WARNING).toMatch(/invite/);
    expect(ADMIN_INVITATION_WARNING).toMatch(/revoke/);
    expect(text(".hp-invite-create")).toMatch(/admin/i);

    const expiry = q<HTMLSelectElement>(".hp-invite-expiry") as HTMLSelectElement;
    expiry.value = "7d";
    await create();
    const post = hub.requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ roles: ["admin"], ttlMs: 7 * 24 * HOUR });
    expect(text(".hp-invite-note")).toMatch(/ADMIN/);

    choose("member");
    expect(shown(".hp-invite-warning")).toBe(false);
  });

  it("offers only member when the hub knows no admin role", async () => {
    const hub = fakeHub({ roles: ["member", "hidden"] });
    const w = mount(hub);
    w.update(live());
    await settle();
    expect(shown(".hp-invite")).toBe(true);
    expect(shown(".hp-invite-role-admin")).toBe(false);
  });

  it("shows a refused create inline, as an alert, and keeps the panel", async () => {
    const hub = fakeHub({ createStatus: 400, createError: "invitation: unknown role 'admin'" });
    const w = mount(hub);
    w.update(live());
    await settle();
    await create();
    expect(shown(".hp-invite-error")).toBe(true);
    expect(q(".hp-invite-error")?.getAttribute("role")).toBe("alert");
    expect(text(".hp-invite-error")).toMatch(/HTTP 400.*unknown role 'admin'/);
    expect(shown(".hp-invite-result")).toBe(false);
    expect(shown(".hp-invite")).toBe(true);
    expect(q<HTMLButtonElement>(".hp-invite-create")?.disabled).toBe(false);
  });

  it("shares through the share sheet when there is one, and copies either way", async () => {
    const hub = fakeHub();
    const share = vi.fn(async (_data: ShareData) => {});
    const copy = vi.fn(async (_text: string) => {});
    const w = mount(hub, { share, copy });
    w.update(live());
    await settle();
    await create();
    expect(shown(".hp-invite-share")).toBe(true);
    q<HTMLButtonElement>(".hp-invite-share")?.click();
    q<HTMLButtonElement>(".hp-invite-copy")?.click();
    await settle();
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: LINK(1) }));
    expect(copy).toHaveBeenCalledWith(LINK(1));
    expect(text(".hp-invite-copied")).toBe("Copied");
  });

  it("hides Share where the browser has no share sheet, and ignores a closed one", async () => {
    const hub = fakeHub();
    const w = mount(hub);
    w.update(live());
    await settle();
    await create();
    expect(shown(".hp-invite-share")).toBe(false);
    expect(shown(".hp-invite-copy")).toBe(true);

    widget?.destroy();
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const w2 = mount(fakeHub(), { share: async () => Promise.reject(abort) });
    w2.update(live());
    await settle();
    await create();
    q<HTMLButtonElement>(".hp-invite-share")?.click();
    await settle();
    expect(shown(".hp-invite-error")).toBe(false);
  });

  it("lists pending invitations with role and expiry, never their ids", async () => {
    const hub = fakeHub();
    const w = mount(hub);
    w.update(live());
    await settle();
    const details = q<HTMLDetailsElement>(".hp-invite") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await settle();
    const items = [...container.querySelectorAll(".hp-invite-pending-item")].map((li) =>
      li.textContent?.replace(/\s+/g, " ").trim(),
    );
    // the expired one is left out
    expect(items).toEqual(["member expires in 3 h"]);
    expect(text(".hp-invite-pending-title")).toBe("Pending invitations (1)");

    await create(); // refreshes the list
    const after = [...container.querySelectorAll(".hp-invite-pending-item")].map(
      (li) => li.textContent,
    );
    expect(after).toHaveLength(2);
    expect(container.innerHTML).not.toMatch(/SECRET-ID/);
  });

  it("forgets the link on screen when the page leaves live", async () => {
    const hub = fakeHub();
    const w = mount(hub);
    w.update(live());
    await settle();
    await create();
    expect(q<HTMLInputElement>(".hp-invite-link")?.value).toBe(LINK(1));
    w.update(disconnected);
    expect(shown(".hp-invite")).toBe(false);
    expect(q<HTMLInputElement>(".hp-invite-link")?.value).toBe("");
    expect(q(".hp-invite-qr")?.innerHTML).toBe("");
  });

  it("lives in the compact widget's menu", async () => {
    const hub = fakeHub();
    const w = mount(hub, {}, { compact: true });
    w.update(live());
    await settle();
    expect(q(".hp-join-menu-panel .hp-invite")).not.toBeNull();
    expect(q<HTMLElement>(".hp-invite")?.hidden).toBe(false);
  });

  it("asks the hub only once the mesh view lists this member as admin", async () => {
    const hub = fakeHub();
    const w = mount(hub);
    let view: MeshViewHint | null = null;
    const handle = { hubPeerId: HUB, baseUrl: BASE, meshView: () => view };
    w.update(live(handle)); // no view yet: wait
    await settle();
    expect(hub.requests).toEqual([]);
    view = { self: PEER, members: [{ peerId: PEER, roles: ["member"] }] };
    w.update(live(handle)); // a plain member: never asked, so no 403 in its console
    await settle();
    expect(hub.requests).toEqual([]);
    expect(shown(".hp-invite")).toBe(false);
    view = { self: PEER, members: [{ peerId: PEER, roles: ["admin"] }] };
    w.update(live(handle));
    await settle();
    expect(hub.requests).toHaveLength(1);
    expect(shown(".hp-invite")).toBe(true);
    view = null; // a view that drops out for a beat keeps the panel for the same hub
    w.update(live(handle));
    await settle();
    expect(shown(".hp-invite")).toBe(true);
    expect(hub.requests).toHaveLength(1);
  });

  it("stays hidden when the view says admin but the hub refuses (403)", async () => {
    const hub = fakeHub({ roleStatuses: [403] });
    const w = mount(hub);
    const view: MeshViewHint = { self: PEER, members: [{ peerId: PEER, roles: ["admin"] }] };
    w.update(live({ hubPeerId: HUB, baseUrl: BASE, meshView: () => view }));
    await settle();
    expect(hub.requests).toHaveLength(1);
    expect(shown(".hp-invite")).toBe(false);
  });

  it("reads the hint from the view", () => {
    const of = (roles: string[] | null) => ({
      hubPeerId: HUB,
      meshView: () => (roles == null ? null : { self: PEER, members: [{ peerId: PEER, roles }] }),
    });
    expect(adminHint(of(["admin"]))).toBe(true);
    expect(adminHint(of(["member"]))).toBe(false);
    expect(adminHint(of(null))).toBeUndefined();
    expect(adminHint({ hubPeerId: HUB })).toBe(true);
    expect(adminHint(null)).toBe(false);
  });

  it("never logs an invitation", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const hub = fakeHub();
      const w = mount(hub);
      w.update(live());
      await settle();
      await create();
      for (const spy of spies) {
        for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/SECRET/);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
