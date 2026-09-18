/**
 * The join widget: one small piece of DOM that renders a `SessionState` and
 * calls the session's four controls.
 *
 * IT HOLDS NO SESSION STATE OF ITS OWN. `PeerSession` already decides every
 * thing worth deciding -- which phase, which message, which controls make
 * sense (`SessionState.controls`) -- and the widget only shows it. The page
 * owns the session and hands each new state to `update()`, because the session
 * reports changes through one `onChange` callback that the page wires up when
 * it creates it; the widget cannot subscribe on its own.
 *
 * What the widget DOES own is what exists only on screen: the text being
 * typed, a camera that is running, a button that is waiting on its call, and
 * the complaint left by a call that rejected.
 *
 * NOTHING HAPPENS AT IMPORT. No `document`, no `window`, no stylesheet until
 * `mountJoinWidget` runs -- `tests/import.test.ts` imports the built entry
 * under plain Node to hold the package to that, because a page's bundle may
 * import this module long before it has anything to mount.
 */

import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { defaultQrScanner, type QrScanner } from "./qr.js";
import { injectJoinWidgetStyles } from "./styles.js";

/** The four calls the widget makes. `PeerSession` satisfies it; a test passes four spies. */
export type JoinWidgetSession = Pick<
  PeerSession,
  "join" | "disconnect" | "reconnect" | "resetIdentity"
>;

/** The part of `SessionState` the widget reads. A full `SessionState` is one; so is a hand-built test state with no handle. */
export type JoinWidgetState = Pick<SessionState, "phase" | "identity" | "hubLink" | "controls">;

export interface JoinWidgetOptions {
  session: JoinWidgetSession;
  /** The state to show at once. Usually `session.state()`; omitted, the widget says it is starting until `update()`. */
  state?: JoinWidgetState | null;
  /**
   * A status line and a small menu with Disconnect and Leave, and no join
   * form -- for a header that stays on screen while the page does its real
   * work. The full widget is the default.
   */
  compact?: boolean;
  /**
   * How QR codes are read. Defaults to `defaultQrScanner()` (html5-qrcode,
   * loaded on the first scan). `null` hides both QR buttons.
   */
  scanner?: QrScanner | null;
  /** Asked before "Leave this mesh". Defaults to `window.confirm`. May be async, for a page with its own dialog. */
  confirm?: (message: string) => boolean | Promise<boolean>;
  /** `false` leaves styling to the page; the class names are the API then. Default `true`. */
  injectStyles?: boolean;
}

export interface JoinWidget {
  /** The widget's root element, already inside the container. */
  readonly element: HTMLElement;
  /** Show a new state. Call it from the session's `onChange`, and on any timer the page already re-reads the state on. */
  update(state: JoinWidgetState | null): void;
  /** Stop the camera if it runs and remove the widget. The stylesheet stays: another instance may be using it. */
  destroy(): void;
}

/** What "Leave this mesh" asks before it forgets the identity. */
export const LEAVE_CONFIRMATION =
  "Leave this mesh and forget this browser's identity?\n\n" +
  "This page becomes a different peer: its current membership is left behind on the hub, and " +
  "joining again needs a new invitation. The page reloads afterwards.";

/** `12D3KooW…a1b2c3`: enough to tell two peers apart on screen. The whole id goes in a tooltip. */
export function shortPeerId(peerId: string): string {
  return peerId.length <= 18 ? peerId : `${peerId.slice(0, 10)}…${peerId.slice(-6)}`;
}

/** The status line's text for a state, for a page that wants it without the widget. */
export function describePhase(state: JoinWidgetState | null): string {
  const phase = state?.phase;
  if (phase == null) return "Starting…";
  switch (phase.kind) {
    case "checking":
      return "Checking this browser's identity…";
    case "starting":
      return `Joining… (${phase.peerState})`;
    case "live":
      return state?.hubLink == null ? "Connected" : `Connected (${state.hubLink})`;
    case "needs-invitation":
      return "Not joined: an invitation is needed";
    case "disconnected":
      return "Disconnected";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Could not join";
  }
}

/**
 * The phase message, and whether it is news or trouble. A first run asking for
 * an invitation is instructions (`status`); a hub that no longer knows this
 * peer, a refused invitation, a duplicate tab or a failure is trouble
 * (`alert`), and an operator's screen reader should say so.
 */
function messageOf(
  state: JoinWidgetState | null,
): { text: string; role: "status" | "alert" } | null {
  const phase = state?.phase;
  switch (phase?.kind) {
    case "live":
      return phase.note == null ? null : { text: phase.note, role: "status" };
    case "needs-invitation":
      return {
        text: phase.message,
        role: phase.reason === "no-identity" || phase.reason === "no-mesh" ? "status" : "alert",
      };
    case "disconnected":
      return { text: phase.message, role: "status" };
    case "blocked":
    case "failed":
      return { text: phase.message, role: "alert" };
    default:
      return null;
  }
}

let instances = 0;

/**
 * Build the widget inside `container` and return its handle.
 *
 * Every id is suffixed per instance, so two widgets on one page -- a full one
 * and a compact one in a header -- never share a label target or a camera
 * host.
 */
export function mountJoinWidget(container: HTMLElement, options: JoinWidgetOptions): JoinWidget {
  const doc = container.ownerDocument;
  if (options.injectStyles !== false) injectJoinWidgetStyles(doc);
  const { session } = options;
  const scanner = options.scanner === undefined ? defaultQrScanner() : options.scanner;
  const confirmLeave =
    options.confirm ?? ((message: string) => doc.defaultView?.confirm(message) ?? false);
  const compact = options.compact === true;
  const n = ++instances;

  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (className: string, label: string): HTMLButtonElement => {
    const b = make("button", `hp-join-button ${className}`, label);
    b.type = "button";
    return b;
  };

  // --- structure ----------------------------------------------------------
  const root = make("div", compact ? "hp-join hp-join-compact" : "hp-join");

  const status = make("p", "hp-join-status");
  status.setAttribute("role", "status");
  const phaseText = make("span", "hp-join-phase");
  const peer = make("code", "hp-join-peer");
  // The compact line leaves the peer id to a tooltip: a header has no room for it.
  if (compact) status.append(phaseText);
  else status.append(phaseText, peer);

  const message = make("p", "hp-join-message");
  const error = make("p", "hp-join-error");
  error.setAttribute("role", "alert");
  error.hidden = true;

  const disconnectButton = button("hp-join-disconnect", "Disconnect");
  const reconnectButton = button("hp-join-reconnect", "Reconnect");
  const resetButton = button("hp-join-reset hp-join-danger", "Leave this mesh…");
  resetButton.title = "Forget this browser's identity. Joining again needs a new invitation.";
  const controls = make("div", "hp-join-controls");
  controls.append(disconnectButton, reconnectButton, resetButton);

  // The join form: only in the full widget.
  const form = make("form", "hp-join-form");
  const input = make("textarea", "hp-join-input");
  input.id = `hp-join-input-${n}`;
  input.rows = 3;
  input.placeholder = "a join link, a join blob, or an invitation id";
  input.autocomplete = "off";
  input.spellcheck = false;
  const label = make("label", "hp-join-label", "Paste an invitation");
  label.htmlFor = input.id;
  const submit = make("button", "hp-join-button hp-join-primary hp-join-submit", "Join");
  submit.type = "submit";
  const cameraButton = button("hp-join-camera", "Scan a QR code");
  const fileLabel = make("label", "hp-join-button hp-join-file", "Scan a QR picture");
  const fileInput = make("input", "hp-join-visually-hidden");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileLabel.append(fileInput);
  const actions = make("div", "hp-join-actions");
  actions.append(submit, cameraButton, fileLabel);
  const viewfinder = make("div", "hp-join-viewfinder");
  viewfinder.id = `hp-join-viewfinder-${n}`;
  viewfinder.hidden = true;
  const stopCameraButton = button("hp-join-camera-stop", "Stop camera");
  stopCameraButton.hidden = true;
  form.append(label, input, actions, viewfinder, stopCameraButton);

  if (compact) {
    const menu = make("details", "hp-join-menu");
    const summary = make("summary", "hp-join-menu-toggle", "Mesh");
    const panel = make("div", "hp-join-menu-panel");
    panel.append(message, error, controls);
    menu.append(summary, panel);
    root.append(status, menu);
  } else {
    root.append(status, message, error, form, controls);
  }
  container.append(root);

  // --- behaviour ----------------------------------------------------------
  let current: JoinWidgetState | null = null;
  let camera: { stop(): Promise<void> } | null = null;
  /** Set while a camera is being STARTED, so a second click or a stop in between is not lost. */
  let cameraStarting = false;
  let destroyed = false;
  /** The buttons whose call has not settled yet. */
  const pending = new Set<HTMLButtonElement>();

  const showError = (text: string | null): void => {
    error.textContent = text ?? "";
    error.hidden = text == null;
  };

  /** Run one session call from a button: disabled until it settles, and a rejection shown rather than lost. */
  const run = async (from: HTMLButtonElement, call: () => Promise<unknown>): Promise<void> => {
    if (pending.has(from)) return;
    pending.add(from);
    from.disabled = true;
    showError(null);
    try {
      await call();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.delete(from);
      if (!destroyed) render();
    }
  };

  const stopCamera = async (): Promise<void> => {
    const running = camera;
    camera = null;
    viewfinder.hidden = true;
    stopCameraButton.hidden = true;
    viewfinder.replaceChildren();
    await running?.stop().catch(() => {});
  };

  const joinWith = (text: string): Promise<void> =>
    run(submit, async () => {
      await session.join(text);
    });

  const onScanned = (invitation: string): void => {
    void stopCamera();
    if (destroyed) return;
    input.value = invitation;
    void joinWith(invitation);
  };

  const render = (): void => {
    const state = current;
    const phase = state?.phase;
    root.dataset.phase = phase?.kind ?? "none";

    phaseText.textContent = describePhase(state);
    const id = state?.identity ?? null;
    peer.hidden = id == null;
    peer.textContent = id == null ? "" : `peer ${shortPeerId(id)}`;
    for (const node of compact ? [status] : [peer]) {
      if (id == null) node.removeAttribute("title");
      else node.title = `This page's peer id: ${id}`;
    }

    const said = messageOf(state);
    message.hidden = said == null;
    message.textContent = said?.text ?? "";
    if (said == null) message.removeAttribute("role");
    else message.setAttribute("role", said.role);

    const allowed = state?.controls ?? {
      join: false,
      disconnect: false,
      reconnect: false,
      reset: false,
    };
    disconnectButton.hidden = !allowed.disconnect;
    reconnectButton.hidden = !allowed.reconnect;
    resetButton.hidden = !allowed.reset;
    controls.hidden = !(allowed.disconnect || allowed.reconnect || allowed.reset);
    for (const b of [disconnectButton, reconnectButton, resetButton]) b.disabled = pending.has(b);

    form.hidden = compact || !allowed.join;
    submit.disabled = pending.has(submit) || input.value.trim() === "";
    cameraButton.hidden = scanner == null || !scanner.cameraAvailable() || camera != null;
    fileLabel.hidden = scanner == null;

    // A camera left running behind a form that has gone -- a join started,
    // or succeeded -- is a light on the operator's laptop for no reason.
    if (form.hidden && camera != null) void stopCamera();
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text !== "") void joinWith(text);
  });
  input.addEventListener("input", () => {
    submit.disabled = pending.has(submit) || input.value.trim() === "";
  });
  disconnectButton.addEventListener("click", () => {
    void run(disconnectButton, () => session.disconnect());
  });
  reconnectButton.addEventListener("click", () => {
    void run(reconnectButton, () => session.reconnect());
  });
  resetButton.addEventListener("click", () => {
    void run(resetButton, async () => {
      if (!(await confirmLeave(LEAVE_CONFIRMATION))) return;
      await stopCamera();
      await session.resetIdentity();
    });
  });

  cameraButton.addEventListener("click", () => {
    if (scanner == null || camera != null || cameraStarting) return;
    cameraStarting = true;
    showError(null);
    viewfinder.hidden = false;
    stopCameraButton.hidden = false;
    cameraButton.hidden = true;
    scanner.scanCamera(viewfinder, onScanned).then(
      (started) => {
        cameraStarting = false;
        // Stopped, destroyed or already scanned while the camera was starting.
        if (destroyed || viewfinder.hidden) {
          void started.stop().catch(() => {});
          return;
        }
        camera = started;
        render();
      },
      (err: unknown) => {
        cameraStarting = false;
        viewfinder.hidden = true;
        stopCameraButton.hidden = true;
        if (destroyed) return;
        showError(
          `Could not start the camera (${err instanceof Error ? err.message : String(err)}). ` +
            "Choose a picture of the QR code instead, or paste the invitation.",
        );
        render();
      },
    );
  });
  stopCameraButton.addEventListener("click", () => {
    void stopCamera().then(() => {
      if (!destroyed) render();
    });
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    // Reset, so choosing the SAME picture again fires `change` a second time.
    fileInput.value = "";
    if (file == null || scanner == null) return;
    showError(null);
    void scanner.scanFile(file).then(
      (found) => {
        if (destroyed) return;
        if (found.ok) {
          input.value = found.invitation;
          void joinWith(found.invitation);
        } else {
          showError(
            found.reason === "no-qr"
              ? "No QR code found in that picture. Try a sharper or closer one."
              : "That QR code is not an invitation.",
          );
        }
      },
      (err: unknown) => {
        if (!destroyed) showError(`Could not read that picture: ${String(err)}`);
      },
    );
  });

  const update = (state: JoinWidgetState | null): void => {
    if (destroyed) return;
    // A join that went through leaves nothing to rejoin with: clear the field
    // so a later failure does not offer the spent invitation back.
    if (state?.phase.kind === "live" && current?.phase.kind !== "live") input.value = "";
    if (state?.phase.kind === "live") showError(null);
    current = state;
    render();
  };

  update(options.state ?? null);

  return {
    element: root,
    update,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      void stopCamera();
      root.remove();
    },
  };
}
