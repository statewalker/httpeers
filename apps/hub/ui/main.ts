/**
 * The hub's local admin UI (spec §5.5): mint invitations, see who joined,
 * revoke someone, and find the LLM dashboard. A port of the demos hub page's
 * markup and behaviour (`apps/demos/src/hub/main.ts`) onto the REST API
 * (`/hub/api/*`, same origin) instead of an in-tab `Hub` object — this page
 * imports no `httpeers-access` and needs no ServiceWorker, because it never
 * touches a token itself.
 *
 * THE QR CARRIES THE LINK, NOT THE BLOB. The demos page's tab-hosted hub
 * encodes the blob because a bare invitation id has no `httpeers.json` to
 * name its mesh; here the hub is a real deployment with a join page at a real
 * URL, and `POST /hub/api/invitations` already folds the blob into that
 * page's `link` (`joinUrl`, which the join page reads back as `?join=`). A
 * phone scanning this QR should open a page, not paste a blob — so the QR
 * encodes `link`. See the task-6 report for this deviation from the demos'
 * rationale.
 */

import { qrSvg } from "@statewalker/httpeers-qr";

interface MeshInfo {
  hubPeerId: string;
  relayAddrs: string[];
  services: string[];
  relay: RelayReport;
}

/** `GET /hub/api/relay` — the supervisor's view, plus the hub's verdict on it. */
interface RelayReport {
  status: "reserved" | "lost" | "stopped";
  relayPeerId: string | null;
  verifiedAt: number | null;
  expiresAt: number | null;
  lostSince: number | null;
  consecutiveFailures: number;
  renewals: number;
  lastError: string | null;
  healthy: boolean;
}

interface MemberView {
  peerId: string;
  roles: string[];
  online: boolean;
  addrs: string[];
  /** The hub's own view of its live connections to this member (`GET /hub/api/members`). */
  link: "direct" | "relay" | null;
}

interface InvitationResult {
  id: string;
  expiresAt: number;
  blob: string;
  link: string;
}

/** How often the members table is re-read. Matches the demos page. */
const MEMBERS_POLL_INTERVAL_MS = 2_000;

/**
 * How often the reservation line is re-read.
 *
 * Slower than the members poll on purpose: it changes on a half-hour cadence,
 * and the one moment it changes fast -- a loss and its recovery -- is the one
 * an operator is watching the page for, which ten seconds still catches.
 */
const RELAY_POLL_INTERVAL_MS = 10_000;

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found == null) throw new Error(`hub admin UI: no #${id} in the markup`);
  return found;
};

const meshIdEl = el("mesh-id");
const relayEl = el("relay");
const servicesEl = el("services");
const dashboardRow = el("dashboard-row");
const dashboardLink = el<HTMLAnchorElement>("dashboard-link");
const errorEl = el("error");
const rolesSelect = el<HTMLSelectElement>("roles");
const mintButton = el<HTMLButtonElement>("mint");
const invitationEl = el("invitation");
const linkInput = el<HTMLInputElement>("link");
const expiresEl = el("expires");
const qrEl = el("qr");
const membersBody = el("members");
const reservationEl = el("reservation");
const adminStatusEl = el("admin-status");

function showError(message: string): void {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} -> ${res.status}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

/**
 * How a member reaches the hub right now, as the HUB computed it from its open
 * connections to that member (`link`). Guessing from advertised addresses was
 * wrong both ways: a relay-fallback member advertises none, and a direct one
 * can advertise a circuit address. Per member, because two members can be on
 * different paths at once.
 */
function connectionOf(link: MemberView["link"]): string {
  if (link === "direct") return "direct";
  if (link === "relay") return "relay";
  return "not connected";
}

/**
 * One line about the reservation: what the relay last said, and when.
 *
 * `verifiedAt` is deliberately on the page even when everything is fine. "Is
 * this number moving?" is the question the incident could not be answered
 * with, because nothing anywhere recorded the last time the relay had agreed.
 */
function renderReservation(relay: RelayReport): void {
  const parts: string[] = [relay.healthy ? relay.status : `${relay.status} (UNHEALTHY)`];
  if (relay.lostSince != null) {
    parts.push(`since ${new Date(relay.lostSince).toLocaleTimeString()}`);
  }
  if (relay.verifiedAt != null) {
    parts.push(`relay confirmed ${new Date(relay.verifiedAt).toLocaleTimeString()}`);
  }
  if (relay.expiresAt != null) {
    parts.push(`expires ${new Date(relay.expiresAt).toLocaleTimeString()}`);
  }
  parts.push(`${relay.renewals} renewals`);
  if (relay.consecutiveFailures > 0) parts.push(`${relay.consecutiveFailures} failures in a row`);
  if (relay.lastError != null) parts.push(relay.lastError);
  reservationEl.textContent = parts.join(" · ");
  reservationEl.className = relay.healthy ? "" : "err";
}

async function loadReservation(): Promise<void> {
  try {
    renderReservation(await getJson<RelayReport>("/hub/api/relay"));
  } catch (err) {
    reservationEl.textContent = `unknown: ${String(err)}`;
  }
}

function renderMembers(members: MemberView[], onRevoke: (peerId: string) => void): void {
  if (members.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted";
    td.textContent = "none yet";
    tr.append(td);
    membersBody.replaceChildren(tr);
    return;
  }

  const rows = members.map((member) => {
    const tr = document.createElement("tr");
    const peer = document.createElement("td");
    peer.className = "mono";
    peer.textContent = member.peerId;
    const roles = document.createElement("td");
    roles.textContent = member.roles.join(", ");
    const presence = document.createElement("td");
    presence.textContent = member.online ? "online" : "offline";
    const connection = document.createElement("td");
    connection.textContent = connectionOf(member.link);
    const action = document.createElement("td");
    const revoke = document.createElement("button");
    revoke.type = "button";
    // The accessible name names WHO: a short, still-identifying prefix, not
    // the full 50-odd character peerId repeated on every row's button.
    revoke.textContent = `Revoke ${member.peerId.slice(0, 12)}`;
    revoke.addEventListener("click", () => onRevoke(member.peerId));
    action.append(revoke);
    tr.append(peer, roles, presence, connection, action);
    return tr;
  });
  membersBody.replaceChildren(...rows);
}

async function loadMembers(onRevoke: (peerId: string) => void): Promise<void> {
  try {
    const members = await getJson<MemberView[]>("/hub/api/members");
    renderMembers(members, onRevoke);
  } catch (err) {
    showError(`Could not load members: ${String(err)}`);
  }
}

/**
 * Remove a member, and revoke what it is already carrying — both halves,
 * same as the demos page: dropping the record alone leaves its still-valid
 * token accepted until it expires.
 */
async function removeMember(peerId: string, onDone: () => void): Promise<void> {
  const confirmed = confirm(
    `Remove ${peerId}?\n\nIts current token stops working immediately, and it will need a ` +
      "new invitation to rejoin.",
  );
  if (!confirmed) return;
  try {
    await getJson(`/hub/api/members/${encodeURIComponent(peerId)}`, { method: "DELETE" });
    adminStatusEl.textContent = `removed ${peerId}`;
    onDone();
  } catch (err) {
    adminStatusEl.textContent = `could not remove ${peerId}: ${String(err)}`;
  }
}

function renderInvitation(created: InvitationResult): void {
  linkInput.value = created.link;
  expiresEl.textContent = `expires ${new Date(created.expiresAt).toLocaleString()}`;
  qrEl.innerHTML = qrSvg(created.link);
  invitationEl.hidden = false;
}

async function mintInvitation(): Promise<void> {
  mintButton.disabled = true;
  try {
    const created = await getJson<InvitationResult>("/hub/api/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles: [rolesSelect.value] }),
    });
    renderInvitation(created);
  } catch (err) {
    showError(`Could not mint an invitation: ${String(err)}`);
  } finally {
    mintButton.disabled = false;
  }
}

async function main(): Promise<void> {
  const mesh = await getJson<MeshInfo>("/hub/api/mesh");
  meshIdEl.textContent = mesh.hubPeerId;
  relayEl.textContent = mesh.relayAddrs.join(", ");
  servicesEl.textContent = mesh.services.length > 0 ? mesh.services.join(", ") : "none";
  renderReservation(mesh.relay);
  setInterval(() => void loadReservation(), RELAY_POLL_INTERVAL_MS);

  if (mesh.services.includes("llm")) {
    // `ui/`, never `ui/login/`: LiteLLM's client router escapes the mesh
    // prefix from the login page once its `token` cookie is set (the door's
    // `rescueDashboardPath` catches a browser that escapes anyway).
    dashboardLink.href = `/peers/${mesh.hubPeerId}/llm/ui/`;
    dashboardRow.hidden = false;
  }

  const roles = await getJson<string[]>("/hub/api/roles");
  rolesSelect.replaceChildren(
    ...roles.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === "member";
      return option;
    }),
  );
  mintButton.disabled = false;
  mintButton.addEventListener("click", () => void mintInvitation());

  const refreshMembers = () =>
    void loadMembers((peerId) => void removeMember(peerId, refreshMembers));
  await loadMembers((peerId) => void removeMember(peerId, refreshMembers));
  setInterval(refreshMembers, MEMBERS_POLL_INTERVAL_MS);
}

main().catch((err: unknown) => {
  showError(`${String(err)}\n\nThe hub's admin API could not be reached.`);
});
