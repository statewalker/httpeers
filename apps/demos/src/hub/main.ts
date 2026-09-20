/**
 * The hub page: mint invitations, see who joined, remove someone.
 *
 * ISO-FUNCTIONAL with the sandbox's `pages/hub/main.ts`, on the extracted
 * libraries. What changed is what is NOT here: the 498-line `hub-runtime.ts`
 * is `../shared/hub-runtime.ts`, composed from packages; the snapshot store is
 * `httpeers-hub/browser`'s `idbStorage`; the QR is `httpeers-qr`; the join blob
 * is `httpeers-member`. This file is the UI and nothing else.
 *
 * THE IDENTITY IS READ AND SHOWN BEFORE THE HUB STARTS. An operator should be
 * able to read the mesh id, and reach the reset link, even when the relay is
 * down and the hub never comes up — which is exactly when they need both.
 */

import {
  encodeJoinBlob,
  joinUrl,
  loadOrCreateIdentity,
  peerIdOf,
} from "@statewalker/httpeers-member";
import { idbBytesBackend } from "@statewalker/httpeers-member/browser";
import { qrSvg } from "@statewalker/httpeers-qr";
import { createDemoSpa, SPA_ADVERTISEMENT } from "../shared/demo-spa.js";
import { type HubHandle, type HubState, startHub } from "../shared/hub-runtime.js";
import { EDGE_KEY, meshRules } from "../shared/policy.js";
import { needsPermissiveGater, readRelayAddrs } from "../shared/relay.js";
import { createSearchEndpoint, fixtureUpstream, SEARCH_ADVERTISEMENT } from "../shared/search.js";

/** How long a minted invitation stays redeemable. */
const INVITATION_TTL_MS = 30 * 60_000;
/** How often the member list and invitation statuses are re-read. */
const VIEW_POLL_INTERVAL_MS = 2_000;

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found == null) throw new Error(`hub page: no #${id} in the markup`);
  return found;
};

const meshIdEl = el("mesh-id");
const stateEl = el("state");
const errorEl = el("error");
const mintButton = el<HTMLButtonElement>("mint");
const mintRolesEl = el<HTMLSelectElement>("mint-roles");
const membersEl = el("members");
const adminStatusEl = el("admin-status");

function setState(state: HubState | "error"): void {
  stateEl.textContent = state;
}

function showError(message: string): void {
  errorEl.hidden = false;
  errorEl.textContent = message;
  setState("error");
}

/** A labelled row with a copy button — every value here is something someone has to move elsewhere. */
function copyRow(label: string, value: string, href?: string): HTMLElement[] {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  const span = document.createElement("span");
  span.className = "mono";
  span.textContent = value;
  dd.append(span, " ");
  const button = document.createElement("button");
  button.textContent = "copy";
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(
      () => {
        button.textContent = "copied";
        setTimeout(() => {
          button.textContent = "copy";
        }, 1200);
      },
      // A clipboard write can be refused (permissions, an insecure context).
      // Saying so beats a button that silently does nothing.
      () => {
        button.textContent = "copy failed";
      },
    );
  });
  dd.append(button);
  if (href != null) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = " open";
    dd.append(link);
  }
  return [dt, dd];
}

function renderInvitation(roles: string[], blob: string, link: string, expiresAt: number): void {
  const rows = el("invitation-rows");
  rows.replaceChildren(
    ...copyRow("roles", roles.join(", ")),
    ...copyRow("link", link, link),
    ...copyRow("blob", blob),
    ...copyRow("expires", new Date(expiresAt).toLocaleTimeString()),
  );
  // The QR carries the BLOB, not the link: a blob names its own mesh, which is
  // what a hub-in-a-tab deployment needs -- there is no `httpeers.json`
  // hubPeerId for a bare invitation id to refer to.
  el("qr").innerHTML = qrSvg(blob);
  el("invitation").hidden = false;
}

function renderMembers(handle: HubHandle): void {
  const view = handle.hub.meshView();
  const rows = view.members.map((member) => {
    const tr = document.createElement("tr");
    const peer = document.createElement("td");
    peer.className = "mono";
    peer.textContent = member.peerId;
    const roles = document.createElement("td");
    roles.textContent = member.roles.join(", ");
    const presence = document.createElement("td");
    presence.textContent = member.online === true ? "online" : "offline";
    const action = document.createElement("td");
    const remove = document.createElement("button");
    remove.textContent = "remove";
    remove.addEventListener("click", () => void removeMember(handle, member.peerId));
    action.append(remove);
    tr.append(peer, roles, presence, action);
    return tr;
  });

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "none yet";
    tr.append(td);
    membersEl.replaceChildren(tr);
    return;
  }
  membersEl.replaceChildren(...rows);
}

/**
 * Remove a member, and revoke what it is already carrying.
 *
 * BOTH HALVES OR THE REMOVAL IS COSMETIC. Dropping the record stops future
 * heartbeats being accepted, but the peer is holding a token that stays valid
 * until it expires; `revocations.revoke` is what makes the live one stop
 * verifying on the next call.
 */
async function removeMember(handle: HubHandle, peerId: string): Promise<void> {
  const confirmed = confirm(
    `Remove ${peerId}?\n\nIts current token stops working immediately, and it will need a ` +
      "new invitation to rejoin.",
  );
  if (!confirmed) return;
  try {
    handle.hub.members.remove(peerId);
    const policyVersion = handle.hub.revocations.revoke(peerId);
    adminStatusEl.textContent = `removed ${peerId} (policy version ${policyVersion})`;
    renderMembers(handle);
  } catch (err) {
    adminStatusEl.textContent = `could not remove ${peerId}: ${String(err)}`;
  }
}

async function main(): Promise<void> {
  // Shown before the hub starts: this is the mesh's name, and it is readable
  // even if nothing below succeeds.
  const privateKey = await loadOrCreateIdentity({ backend: idbBytesBackend() });
  meshIdEl.textContent = peerIdOf(privateKey);

  const relayAddrs = await readRelayAddrs();

  const handle = await startHub({
    key: EDGE_KEY,
    privateKey,
    relayAddrs,
    rules: meshRules(),
    // THE HUB SERVES SEARCH, and advertises it in the same breath. Mounting
    // without advertising is how the prototype ended up with an endpoint that
    // was served, gated and invisible.
    // And a small app, for the app page to open in a session origin of its
    // own (`../shared/demo-spa.ts`, `../shared/session-frame.ts`).
    extraMounts: {
      "/search": createSearchEndpoint({ upstream: fixtureUpstream }),
      [`/${SPA_ADVERTISEMENT.id}`]: createDemoSpa(),
    },
    ownAdvertisements: [SEARCH_ADVERTISEMENT, SPA_ADVERTISEMENT],
    // Decided from the ADDRESS being dialled, never this page's hostname: a
    // page served from a LAN address dialling a loopback relay is still a
    // development setup, and the hostname test would deny every dial while
    // blaming the relay.
    dev: needsPermissiveGater(relayAddrs),
    onState: setState,
  });

  // The peerId the node actually came up with, not the one derived above. They
  // must be equal -- the same key produced both -- so rendering the
  // authoritative one makes a mismatch visible rather than theoretical.
  meshIdEl.textContent = handle.peerId;
  el("relay").textContent = handle.relayAddr;
  el("circuit").textContent = handle.circuitAddr;
  el("base-url").textContent = handle.baseUrl;

  // Role options come from the mesh's own rules, so a role added to the policy
  // appears here with no second list to remember.
  mintRolesEl.replaceChildren(
    ...handle.roles().map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === "member";
      return option;
    }),
  );

  mintButton.disabled = false;
  mintButton.addEventListener("click", () => {
    void (async () => {
      mintButton.disabled = true;
      try {
        const roles = [mintRolesEl.value];
        // A NEW invitation on every press: they are single-use, so an operator
        // pressing twice must get two distinct codes. The hub generates the id
        // itself -- 128 bits from the platform CSPRNG -- because whoever holds
        // one can become a member.
        const created = await handle.hub.invitations.create(roles, INVITATION_TTL_MS);
        const blob = encodeJoinBlob({
          invitationId: created.id,
          relayAddrs: [handle.relayAddr],
          hubPeerId: handle.peerId,
        });
        renderInvitation(
          roles,
          blob,
          joinUrl(location.origin, {
            invitationId: created.id,
            relayAddrs: [handle.relayAddr],
            hubPeerId: handle.peerId,
          }),
          created.expiresAt,
        );
      } catch (err) {
        showError(`Could not mint an invitation: ${String(err)}`);
      } finally {
        mintButton.disabled = false;
      }
    })();
  });

  renderMembers(handle);
  setInterval(() => renderMembers(handle), VIEW_POLL_INTERVAL_MS);
}

main().catch((err: unknown) => {
  showError(
    `${String(err)}\n\nThe mesh is not running. If this keeps happening, reset this app ` +
      "from the link below — it clears this browser's copy and starts over.",
  );
});
