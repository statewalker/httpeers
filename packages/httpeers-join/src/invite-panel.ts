/**
 * The Invite panel: an admin makes an invitation -- member or admin, one
 * hour, one day or seven days -- and hands it over as a link, a QR code, the
 * phone's share sheet or the clipboard. Pending invitations are listed with
 * their role and how long they have left.
 *
 * SHOWN ONLY TO AN ADMIN, AND THE HUB SAYS WHO THAT IS. The panel stays
 * hidden until the page is live, the mesh view lists this member as `admin`
 * (`adminHint`: the hint that decides whether to ask), and
 * `GET /hub/api/roles` succeeded for it (`./invite.ts`). A 403 (a member), a 404 (a hub with no admin API)
 * or a 401 hides it for the life of that link; a network error or a 5xx is
 * tried again a few times, because the first call can race the link coming
 * up. It is a convenience, never a gate: the hub decides every call.
 *
 * WHAT IS ON SCREEN IS A SECRET. The link, and the QR code of it, redeem
 * once for whoever holds them. They are never logged, the pending list shows
 * no invitation ids (a bare id redeems too), and all of it is cleared when the
 * link to the hub goes away.
 */

import {
  ADMIN_INVITATION_WARNING,
  adminHint,
  type CreatedInvitation,
  createHubAdminClient,
  DEFAULT_INVITE_EXPIRY,
  DEFAULT_INVITE_ROLE,
  describeExpiry,
  expiryMs,
  type HubAdminClient,
  type HubTarget,
  hubAdminBase,
  INVITE_EXPIRIES,
  INVITE_ROLES,
  type InviteRole,
  isFinalRefusal,
  offeredRoles,
  type PendingInvitation,
} from "./invite.js";

export interface InvitePanelOptions {
  /** How the hub is called. Defaults to the page's `fetch`, which the ServiceWorker edge routes over the mesh. */
  fetch?: typeof fetch;
  /** The share sheet. Defaults to `navigator.share` where it exists; `null` hides Share. */
  share?: ((data: ShareData) => Promise<void>) | null;
  /** Copies text. Defaults to `navigator.clipboard.writeText`, falling back to selecting the link and `execCommand("copy")`. */
  copy?: (text: string) => Promise<void>;
  /** The QR code of a link, as SVG markup. Defaults to `qrSvg` from `@statewalker/httpeers-qr`, loaded on first use. */
  qrSvg?: (text: string) => string | Promise<string>;
  /** The clock expiries are shown against. */
  now?: () => number;
  /** How long to wait before asking for the roles again after a non-final failure. Default 2 s. */
  retryDelayMs?: number;
  /** How many times the roles are asked for, in all. Default 3. */
  roleAttempts?: number;
}

export interface InvitePanel {
  readonly element: HTMLElement;
  /** Point the panel at a live link's hub, or at nothing (`null`) when the page is not live. Idempotent. */
  setTarget(target: HubTarget | null): void;
  destroy(): void;
}

type Make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
) => HTMLElementTagNameMap[K];

const pageFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

async function defaultQrSvg(text: string): Promise<string> {
  const { qrSvg } = await import("@statewalker/httpeers-qr");
  return qrSvg(text);
}

function defaultShare(doc: Document): ((data: ShareData) => Promise<void>) | null {
  const nav = doc.defaultView?.navigator;
  if (nav == null || typeof nav.share !== "function") return null;
  return (data) => nav.share(data);
}

/**
 * Build the panel (hidden) with `make`, the widget's element helper. `n` is
 * the widget instance number, for unique ids.
 */
export function createInvitePanel(
  doc: Document,
  make: Make,
  n: number,
  options: InvitePanelOptions = {},
): InvitePanel {
  const fetchImpl = options.fetch ?? pageFetch;
  const share = options.share === undefined ? defaultShare(doc) : options.share;
  const toQrSvg = options.qrSvg ?? defaultQrSvg;
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const roleAttempts = Math.max(1, options.roleAttempts ?? 3);

  const button = (className: string, label: string): HTMLButtonElement => {
    const b = make("button", `hp-join-button ${className}`, label);
    b.type = "button";
    return b;
  };

  // --- structure ----------------------------------------------------------
  const root = make("details", "hp-invite");
  root.hidden = true;
  const summary = make("summary", "hp-invite-toggle", "Invite someone");
  const body = make("div", "hp-invite-body");

  const roleGroup = make("fieldset", "hp-invite-roles");
  const roleLegend = make("legend", "hp-invite-legend", "Invite as");
  roleGroup.append(roleLegend);
  const roleInputs = new Map<InviteRole, { input: HTMLInputElement; label: HTMLLabelElement }>();
  for (const role of INVITE_ROLES) {
    const label = make("label", `hp-invite-role hp-invite-role-${role}`);
    const input = make("input", "hp-invite-role-input");
    input.type = "radio";
    input.name = `hp-invite-role-${n}`;
    input.value = role;
    input.checked = role === DEFAULT_INVITE_ROLE;
    label.append(input, ` ${role === "admin" ? "Admin" : "Member"}`);
    roleGroup.append(label);
    roleInputs.set(role, { input, label });
  }
  const warning = make("p", "hp-invite-warning", ADMIN_INVITATION_WARNING);
  warning.setAttribute("role", "note");

  const expiry = make("select", "hp-invite-expiry");
  expiry.id = `hp-invite-expiry-${n}`;
  for (const e of INVITE_EXPIRIES) {
    const option = make("option", "", `Expires in ${e.label}`);
    option.value = e.id;
    option.selected = e.id === DEFAULT_INVITE_EXPIRY;
    expiry.append(option);
  }
  const expiryLabel = make("label", "hp-join-visually-hidden", "Expiry");
  expiryLabel.htmlFor = expiry.id;

  const create = button("hp-join-primary hp-invite-create", "Create invitation");
  const createRow = make("div", "hp-join-actions");
  createRow.append(expiryLabel, expiry, create);

  const error = make("p", "hp-join-error hp-invite-error");
  error.setAttribute("role", "alert");
  error.hidden = true;

  const result = make("div", "hp-invite-result");
  result.hidden = true;
  const resultNote = make("p", "hp-invite-note");
  const qr = make("div", "hp-invite-qr");
  const link = make("input", "hp-join-input hp-invite-link");
  link.id = `hp-invite-link-${n}`;
  link.type = "text";
  link.readOnly = true;
  link.autocomplete = "off";
  link.spellcheck = false;
  const linkLabel = make("label", "hp-join-visually-hidden", "Invitation link");
  linkLabel.htmlFor = link.id;
  const shareButton = button("hp-join-primary hp-invite-share", "Share");
  const copyButton = button("hp-invite-copy", "Copy link");
  const copied = make("span", "hp-invite-copied");
  copied.setAttribute("role", "status");
  const resultActions = make("div", "hp-join-actions");
  resultActions.append(shareButton, copyButton, copied);
  result.append(resultNote, qr, linkLabel, link, resultActions);

  const pendingBox = make("div", "hp-invite-pending");
  const pendingHead = make("div", "hp-invite-pending-head");
  const pendingTitle = make("p", "hp-invite-pending-title", "Pending invitations");
  const refresh = button("hp-invite-refresh", "Refresh");
  pendingHead.append(pendingTitle, refresh);
  const pendingList = make("ul", "hp-invite-pending-list");
  const pendingEmpty = make("p", "hp-invite-pending-empty", "None.");
  pendingBox.append(pendingHead, pendingList, pendingEmpty);

  body.append(roleGroup, warning, createRow, error, result, pendingBox);
  root.append(summary, body);

  // --- behaviour ----------------------------------------------------------
  let apiBase: string | null = null;
  let client: HubAdminClient | null = null;
  /** Bumped on every target change and on destroy: an answer for an older link writes nothing. */
  let generation = 0;
  let destroyed = false;
  let creating = false;
  let loadingPending = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let current: CreatedInvitation | null = null;

  const showError = (text: string | null): void => {
    error.textContent = text ?? "";
    error.hidden = text == null;
  };
  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const selectedRole = (): InviteRole => {
    for (const [role, { input }] of roleInputs) if (input.checked) return role;
    return DEFAULT_INVITE_ROLE;
  };

  const renderRole = (): void => {
    const role = selectedRole();
    warning.hidden = role !== "admin";
    root.dataset.role = role;
    create.textContent = role === "admin" ? "Create admin invitation" : "Create invitation";
    create.classList.toggle("hp-invite-create-admin", role === "admin");
  };

  const clearResult = (): void => {
    current = null;
    result.hidden = true;
    link.value = "";
    qr.replaceChildren();
    copied.textContent = "";
    resultNote.textContent = "";
  };

  const renderPending = (items: PendingInvitation[]): void => {
    const t = now();
    const live = items.filter((i) => i.expiresAt > t).sort((a, b) => a.expiresAt - b.expiresAt);
    pendingList.replaceChildren(
      ...live.map((item) => {
        const li = make("li", "hp-invite-pending-item");
        const role = item.roles.join(", ") || "(no role)";
        const roleTag = make(
          "span",
          `hp-invite-tag${item.roles.includes("admin") ? " hp-invite-tag-admin" : ""}`,
          role,
        );
        const when = make("span", "hp-invite-when", `expires ${describeExpiry(item.expiresAt, t)}`);
        when.title = new Date(item.expiresAt).toLocaleString();
        li.append(roleTag, " ", when);
        return li;
      }),
    );
    pendingTitle.textContent = `Pending invitations (${live.length})`;
    pendingEmpty.hidden = live.length > 0;
  };

  const loadPending = async (): Promise<void> => {
    const c = client;
    const gen = generation;
    if (c == null || loadingPending) return;
    loadingPending = true;
    refresh.disabled = true;
    try {
      const items = await c.pending();
      if (gen === generation && !destroyed) renderPending(items);
    } catch (err) {
      if (gen === generation && !destroyed) showError(messageOf(err));
    } finally {
      loadingPending = false;
      refresh.disabled = false;
    }
  };

  const showCreated = async (created: CreatedInvitation, role: InviteRole): Promise<void> => {
    current = created;
    link.value = created.link;
    resultNote.textContent =
      `Anyone with this link joins as ${role === "admin" ? "an ADMIN" : "a member"}, once, ` +
      `until ${new Date(created.expiresAt).toLocaleString()}. Send it only to the person you mean.`;
    shareButton.hidden = share == null;
    copied.textContent = "";
    result.hidden = false;
    qr.replaceChildren();
    const gen = generation;
    try {
      const svg = await toQrSvg(created.link);
      if (gen !== generation || destroyed || current !== created) return;
      // Our own encoder's markup, from a string it built: no page content goes in.
      qr.innerHTML = svg;
    } catch {
      // No QR is not fatal: the link, Share and Copy still work.
    }
  };

  const hide = (): void => {
    root.hidden = true;
    root.open = false;
    clearResult();
    showError(null);
    pendingList.replaceChildren();
    pendingEmpty.hidden = false;
    pendingTitle.textContent = "Pending invitations";
  };

  const detect = async (gen: number, c: HubAdminClient): Promise<void> => {
    for (let attempt = 1; attempt <= roleAttempts; attempt++) {
      try {
        const roles = await c.roles();
        if (gen !== generation || destroyed) return;
        const offered = offeredRoles(roles);
        if (offered.length === 0) return; // an admin, but of a hub with neither role: nothing to offer
        for (const [role, { input, label }] of roleInputs) {
          label.hidden = !offered.includes(role);
          input.disabled = !offered.includes(role);
        }
        if (!offered.includes(selectedRole())) {
          const first = roleInputs.get(offered[0] as InviteRole);
          if (first != null) first.input.checked = true;
        }
        renderRole();
        root.hidden = false;
        return;
      } catch (err) {
        if (gen !== generation || destroyed || isFinalRefusal(err)) return;
        if (attempt < roleAttempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          if (gen !== generation || destroyed) return;
        }
      }
    }
  };

  const setTarget = (target: HubTarget | null): void => {
    if (destroyed) return;
    let base = hubAdminBase(target);
    const hint = base == null ? false : adminHint(target);
    // No view yet: keep whatever was decided for this same hub, else wait for one.
    if (hint === undefined && base === apiBase) return;
    if (hint !== true) base = null;
    if (base === apiBase) return;
    apiBase = base;
    generation++;
    client = base == null ? null : createHubAdminClient(fetchImpl, base);
    hide();
    if (client != null) void detect(generation, client);
  };

  for (const { input } of roleInputs.values()) input.addEventListener("change", renderRole);

  root.addEventListener("toggle", () => {
    if (root.open) void loadPending();
  });
  refresh.addEventListener("click", () => {
    showError(null);
    void loadPending();
  });

  create.addEventListener("click", () => {
    const c = client;
    if (c == null || creating) return;
    const gen = generation;
    const role = selectedRole();
    creating = true;
    create.disabled = true;
    showError(null);
    clearResult();
    c.create(role, expiryMs(expiry.value)).then(
      async (created) => {
        creating = false;
        create.disabled = false;
        if (gen !== generation || destroyed) return;
        await showCreated(created, role);
        void loadPending();
      },
      (err: unknown) => {
        creating = false;
        create.disabled = false;
        if (gen === generation && !destroyed) showError(messageOf(err));
      },
    );
  });

  link.addEventListener("focus", () => link.select());

  const flashCopied = (text: string): void => {
    copied.textContent = text;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.textContent = "";
    }, 2_500);
  };

  copyButton.addEventListener("click", () => {
    const value = current?.link;
    if (value == null) return;
    const viaSelection = (): void => {
      link.focus();
      link.select();
      const ok = doc.execCommand?.("copy") ?? false;
      flashCopied(ok ? "Copied" : "Select the link and copy it");
    };
    const copy =
      options.copy ??
      (doc.defaultView?.navigator.clipboard?.writeText != null
        ? (text: string) => (doc.defaultView as Window).navigator.clipboard.writeText(text)
        : null);
    if (copy == null) {
      viaSelection();
      return;
    }
    copy(value).then(
      () => flashCopied("Copied"),
      () => viaSelection(),
    );
  });

  shareButton.addEventListener("click", () => {
    const value = current?.link;
    if (value == null || share == null) return;
    share({ title: "Join the mesh", text: "An invitation to join the mesh:", url: value }).catch(
      (err: unknown) => {
        // Closing the share sheet is not an error.
        if ((err as { name?: unknown } | null)?.name === "AbortError") return;
        showError(`Could not share (${messageOf(err)}). Copy the link instead.`);
      },
    );
  });

  renderRole();

  return {
    element: root,
    setTarget,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      clearTimeout(copiedTimer);
      clearResult();
      root.remove();
    },
  };
}
