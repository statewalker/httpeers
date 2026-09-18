/**
 * The widget, driven by a FAKE session through every phase.
 *
 * The session is the real thing's shape and nothing more: four methods that
 * record their calls, and states built by hand. What is asserted is what an
 * operator would see and be able to press -- the status line, the message and
 * its role, which buttons exist -- and that pressing them calls the session.
 */

import type { SessionControls, SessionPhase } from "@statewalker/httpeers-member";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describePhase,
  type JoinWidget,
  type JoinWidgetOptions,
  type JoinWidgetSession,
  type JoinWidgetState,
  mountJoinWidget,
  type QrFileScan,
  type QrScanner,
  shortPeerId,
} from "../src/index.js";

const PEER = "12D3KooWAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef";

/** The session's own `controlsFor`, restated: the widget must obey whatever it is handed, and these are the real values. */
function controlsFor(phase: SessionPhase): SessionControls {
  switch (phase.kind) {
    case "live":
      return { join: false, disconnect: true, reconnect: false, reset: true };
    case "disconnected":
      return { join: false, disconnect: false, reconnect: true, reset: true };
    case "blocked":
      return { join: false, disconnect: false, reconnect: false, reset: true };
    case "checking":
    case "starting":
      return { join: false, disconnect: false, reconnect: false, reset: false };
    default:
      return { join: true, disconnect: false, reconnect: false, reset: true };
  }
}

function stateOf(phase: SessionPhase, extra: Partial<JoinWidgetState> = {}): JoinWidgetState {
  return {
    phase,
    identity: PEER,
    hubLink: phase.kind === "live" ? "relay" : null,
    controls: controlsFor(phase),
    ...extra,
  };
}

function fakeSession(): JoinWidgetSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    join: vi.fn(async (text: string) => {
      calls.push(`join:${text}`);
    }),
    disconnect: vi.fn(async () => {
      calls.push("disconnect");
    }),
    reconnect: vi.fn(async () => {
      calls.push("reconnect");
    }),
    resetIdentity: vi.fn(async () => {
      calls.push("reset");
    }),
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

function mount(options: Partial<JoinWidgetOptions> & { session: JoinWidgetSession }): JoinWidget {
  widget = mountJoinWidget(container, { scanner: null, ...options });
  return widget;
}

const q = <T extends Element = HTMLElement>(selector: string): T | null =>
  container.querySelector<T>(selector);

/** Present AND not hidden, by itself or by an ancestor inside the widget. */
function shown(selector: string): boolean {
  let node = q(selector);
  if (node == null) return false;
  const root = q(".hp-join");
  while (node != null && node !== container) {
    if ((node as HTMLElement).hidden) return false;
    if (node === root) break;
    node = node.parentElement;
  }
  return true;
}

const text = (selector: string): string => q(selector)?.textContent?.trim() ?? "";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("status line", () => {
  it("names every phase", () => {
    const session = fakeSession();
    const w = mount({ session });
    const cases: [SessionPhase, RegExp][] = [
      [{ kind: "checking" }, /checking/i],
      [{ kind: "starting", peerState: "loading-config" }, /joining.*loading-config/i],
      [{ kind: "starting", peerState: "dialing-hub" }, /joining.*dialing-hub/i],
      [{ kind: "live", joinedBy: "redeemed", note: null }, /^Connected \(relay\)$/],
      [
        {
          kind: "needs-invitation",
          reason: "no-identity",
          message: "This page has no saved identity yet",
        },
        /not joined/i,
      ],
      [{ kind: "disconnected", message: "Disconnected. Still a member." }, /^disconnected$/i],
      [{ kind: "blocked", message: "Another live peer" }, /blocked/i],
      [{ kind: "failed", message: "Error: relay down" }, /could not join/i],
    ];
    for (const [phase, want] of cases) {
      w.update(stateOf(phase));
      expect(text(".hp-join-phase"), phase.kind).toMatch(want);
      expect(q(".hp-join")?.getAttribute("data-phase")).toBe(phase.kind);
      expect(q(".hp-join-status")?.getAttribute("role")).toBe("status");
    }
  });

  it("says direct when the hub link is direct, and just Connected when unknown", () => {
    const w = mount({ session: fakeSession() });
    w.update(stateOf({ kind: "live", joinedBy: "resumed", note: null }, { hubLink: "direct" }));
    expect(text(".hp-join-phase")).toBe("Connected (direct)");
    w.update(stateOf({ kind: "live", joinedBy: "resumed", note: null }, { hubLink: null }));
    expect(text(".hp-join-phase")).toBe("Connected");
  });

  it("shows a short own peer id, with the whole one on hover", () => {
    const w = mount({ session: fakeSession() });
    w.update(stateOf({ kind: "live", joinedBy: "resumed", note: null }));
    const peer = q(".hp-join-peer");
    expect(peer?.textContent).toContain(shortPeerId(PEER));
    expect(peer?.getAttribute("title")).toContain(PEER);
    w.update(
      stateOf(
        { kind: "needs-invitation", reason: "no-identity", message: "m" },
        { identity: null },
      ),
    );
    expect(shown(".hp-join-peer")).toBe(false);
  });

  it("before any state, says it is starting and offers nothing", () => {
    mount({ session: fakeSession() });
    expect(text(".hp-join-phase")).toMatch(/starting/i);
    expect(shown(".hp-join-form")).toBe(false);
    const offered = ["submit", "camera", "file", "disconnect", "reconnect", "reset"].filter((b) =>
      shown(`.hp-join-${b}`),
    );
    expect(offered).toEqual([]);
  });
});

describe("messages", () => {
  it("shows the phase message with a role that fits it", () => {
    const w = mount({ session: fakeSession() });
    const cases: [SessionPhase, string][] = [
      [{ kind: "needs-invitation", reason: "no-identity", message: "first run" }, "status"],
      [{ kind: "needs-invitation", reason: "unknown-identity", message: "hub reset" }, "alert"],
      [{ kind: "needs-invitation", reason: "invitation-refused", message: "spent" }, "alert"],
      [{ kind: "disconnected", message: "still a member" }, "status"],
      [{ kind: "blocked", message: "two tabs" }, "alert"],
      [{ kind: "failed", message: "relay down" }, "alert"],
    ];
    for (const [phase, role] of cases) {
      w.update(stateOf(phase));
      expect(shown(".hp-join-message"), phase.kind).toBe(true);
      expect(text(".hp-join-message")).toBe((phase as { message: string }).message);
      expect(q(".hp-join-message")?.getAttribute("role"), phase.kind).toBe(role);
    }
  });

  it("shows a live note, and nothing when there is none", () => {
    const w = mount({ session: fakeSession() });
    w.update(stateOf({ kind: "live", joinedBy: "resumed", note: "resumed instead" }));
    expect(text(".hp-join-message")).toBe("resumed instead");
    w.update(stateOf({ kind: "live", joinedBy: "redeemed", note: null }));
    expect(shown(".hp-join-message")).toBe(false);
  });

  it("shows a rejected join as an alert", async () => {
    const session = fakeSession();
    session.join = vi.fn(async () => {
      throw new Error("the hub said no");
    });
    const w = mount({ session });
    w.update(stateOf({ kind: "needs-invitation", reason: "no-identity", message: "m" }));
    const input = q<HTMLTextAreaElement>(".hp-join-input");
    if (input == null) throw new Error("no input");
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    q<HTMLFormElement>(".hp-join-form")?.requestSubmit();
    await flush();
    expect(shown(".hp-join-error")).toBe(true);
    expect(q(".hp-join-error")?.getAttribute("role")).toBe("alert");
    expect(text(".hp-join-error")).toContain("the hub said no");
  });
});

describe("buttons follow state.controls", () => {
  const visible = () =>
    ["submit", "disconnect", "reconnect", "reset"].filter((b) => shown(`.hp-join-${b}`));

  it.each<[SessionPhase, string[]]>([
    [{ kind: "checking" }, []],
    [{ kind: "starting", peerState: "loading-config" }, []],
    [{ kind: "live", joinedBy: "redeemed", note: null }, ["disconnect", "reset"]],
    [{ kind: "needs-invitation", reason: "no-identity", message: "m" }, ["submit", "reset"]],
    [{ kind: "disconnected", message: "m" }, ["reconnect", "reset"]],
    [{ kind: "blocked", message: "m" }, ["reset"]],
    [{ kind: "failed", message: "m" }, ["submit", "reset"]],
  ])("%o", (phase, want) => {
    const w = mount({ session: fakeSession() });
    w.update(stateOf(phase));
    expect(visible()).toEqual(want);
    expect(shown(".hp-join-form")).toBe(want.includes("submit"));
  });
});

describe("leaving needs something to leave", () => {
  it("hides Leave on a first run, when there is no identity to forget", () => {
    const w = mount({ session: fakeSession() });
    w.update(
      stateOf(
        { kind: "needs-invitation", reason: "no-identity", message: "m" },
        { identity: null },
      ),
    );
    expect(shown(".hp-join-reset")).toBe(false);
    expect(shown(".hp-join-controls")).toBe(false);
    expect(shown(".hp-join-submit")).toBe(true);
  });
});

describe("actions call the session", () => {
  it("join sends the trimmed pasted text, and is disabled while empty", async () => {
    const session = fakeSession();
    const w = mount({ session });
    w.update(stateOf({ kind: "needs-invitation", reason: "no-identity", message: "m" }));
    const submit = q<HTMLButtonElement>(".hp-join-submit");
    const input = q<HTMLTextAreaElement>(".hp-join-input");
    if (submit == null || input == null) throw new Error("no form");
    expect(submit.disabled).toBe(true);
    expect(q("label.hp-join-label")?.getAttribute("for")).toBe(input.id);
    input.value = "  https://x.example/?join=eyJabc  ";
    input.dispatchEvent(new Event("input"));
    expect(submit.disabled).toBe(false);
    q<HTMLFormElement>(".hp-join-form")?.requestSubmit();
    await flush();
    expect(session.calls).toEqual(["join:https://x.example/?join=eyJabc"]);
  });

  it("an empty submit calls nothing", async () => {
    const session = fakeSession();
    const w = mount({ session });
    w.update(stateOf({ kind: "failed", message: "m" }));
    q<HTMLFormElement>(".hp-join-form")?.requestSubmit();
    await flush();
    expect(session.calls).toEqual([]);
  });

  it("the pasted text is cleared once live", () => {
    const w = mount({ session: fakeSession() });
    w.update(stateOf({ kind: "needs-invitation", reason: "no-identity", message: "m" }));
    const input = q<HTMLTextAreaElement>(".hp-join-input");
    if (input == null) throw new Error("no input");
    input.value = "abc";
    w.update(stateOf({ kind: "starting", peerState: "loading-config" }));
    expect(input.value).toBe("abc");
    w.update(stateOf({ kind: "live", joinedBy: "redeemed", note: null }));
    expect(input.value).toBe("");
  });

  it("disconnect and reconnect", async () => {
    const session = fakeSession();
    const w = mount({ session });
    w.update(stateOf({ kind: "live", joinedBy: "redeemed", note: null }));
    q<HTMLButtonElement>(".hp-join-disconnect")?.click();
    await flush();
    w.update(stateOf({ kind: "disconnected", message: "m" }));
    q<HTMLButtonElement>(".hp-join-reconnect")?.click();
    await flush();
    expect(session.calls).toEqual(["disconnect", "reconnect"]);
  });

  it("a button is disabled while its call runs", async () => {
    const session = fakeSession();
    let release: () => void = () => {};
    session.disconnect = vi.fn(() => new Promise<void>((r) => (release = r)));
    const w = mount({ session });
    w.update(stateOf({ kind: "live", joinedBy: "redeemed", note: null }));
    const button = q<HTMLButtonElement>(".hp-join-disconnect");
    button?.click();
    expect(button?.disabled).toBe(true);
    button?.click();
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(button?.disabled).toBe(false);
  });

  it("leaving asks first, and does nothing when refused", async () => {
    const session = fakeSession();
    const confirm = vi.fn((_message: string) => false);
    const w = mount({ session, confirm });
    w.update(stateOf({ kind: "live", joinedBy: "redeemed", note: null }));
    q<HTMLButtonElement>(".hp-join-reset")?.click();
    await flush();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatch(/new invitation/i);
    expect(session.calls).toEqual([]);

    confirm.mockReturnValue(true);
    q<HTMLButtonElement>(".hp-join-reset")?.click();
    await flush();
    expect(session.calls).toEqual(["reset"]);
  });

  it("an async confirm is awaited", async () => {
    const session = fakeSession();
    const w = mount({ session, confirm: async () => true });
    w.update(stateOf({ kind: "blocked", message: "m" }));
    q<HTMLButtonElement>(".hp-join-reset")?.click();
    await flush();
    expect(session.calls).toEqual(["reset"]);
  });

  it("a rejected disconnect is shown, not swallowed", async () => {
    const session = fakeSession();
    session.disconnect = vi.fn(async () => {
      throw new Error("stop failed");
    });
    const w = mount({ session });
    w.update(stateOf({ kind: "live", joinedBy: "redeemed", note: null }));
    q<HTMLButtonElement>(".hp-join-disconnect")?.click();
    await flush();
    expect(text(".hp-join-error")).toContain("stop failed");
  });
});

describe("QR", () => {
  function fakeScanner(options: { camera?: boolean } = {}) {
    const scanner = {
      stops: 0,
      cameraAvailable: () => options.camera !== false,
      scanCamera: vi.fn(async (_host: HTMLElement, _onInvitation: (text: string) => void) => ({
        stop: async () => {
          scanner.stops++;
        },
      })),
      scanFile: vi.fn(
        async (_file: Blob): Promise<QrFileScan> => ({ ok: true, invitation: "eyJfromfile" }),
      ),
    };
    return scanner satisfies QrScanner;
  }

  const needs = stateOf({ kind: "needs-invitation", reason: "no-identity", message: "m" });

  it("hides the QR buttons with no scanner", () => {
    const w = mount({ session: fakeSession(), scanner: null });
    w.update(needs);
    expect(shown(".hp-join-camera")).toBe(false);
    expect(shown(".hp-join-file")).toBe(false);
  });

  it("hides the camera button when no camera API is there, keeps the picture", () => {
    const w = mount({ session: fakeSession(), scanner: fakeScanner({ camera: false }) });
    w.update(needs);
    expect(shown(".hp-join-camera")).toBe(false);
    expect(shown(".hp-join-file")).toBe(true);
    expect(q<HTMLInputElement>(".hp-join-file input")?.accept).toBe("image/*");
  });

  it("a camera scan joins with the decoded invitation and fills the field", async () => {
    const session = fakeSession();
    const scanner = fakeScanner();
    const w = mount({ session, scanner });
    w.update(needs);
    q<HTMLButtonElement>(".hp-join-camera")?.click();
    await flush();
    expect(scanner.scanCamera).toHaveBeenCalledOnce();
    const host = scanner.scanCamera.mock.calls[0]?.[0];
    expect(host?.id).toMatch(/^hp-join-viewfinder-/);
    expect(host?.isConnected).toBe(true);
    expect(shown(".hp-join-viewfinder")).toBe(true);
    expect(shown(".hp-join-camera-stop")).toBe(true);
    // The scanner calls back with the first accepted code, having stopped itself.
    scanner.scanCamera.mock.calls[0]?.[1]("eyJfromcamera");
    await flush();
    expect(session.calls).toEqual(["join:eyJfromcamera"]);
    expect(q<HTMLTextAreaElement>(".hp-join-input")?.value).toBe("eyJfromcamera");
    expect(shown(".hp-join-viewfinder")).toBe(false);
  });

  it("stop camera stops it; a camera that will not start says so", async () => {
    const scanner = fakeScanner();
    const w = mount({ session: fakeSession(), scanner });
    w.update(needs);
    q<HTMLButtonElement>(".hp-join-camera")?.click();
    await flush();
    q<HTMLButtonElement>(".hp-join-camera-stop")?.click();
    await flush();
    expect(scanner.stops).toBe(1);
    expect(shown(".hp-join-viewfinder")).toBe(false);

    scanner.scanCamera.mockRejectedValueOnce(new Error("NotAllowedError"));
    q<HTMLButtonElement>(".hp-join-camera")?.click();
    await flush();
    expect(text(".hp-join-error")).toMatch(/camera.*NotAllowedError.*picture/i);
    expect(shown(".hp-join-viewfinder")).toBe(false);
  });

  it("the camera is stopped when the join form goes away, and on destroy", async () => {
    const scanner = fakeScanner();
    const w = mount({ session: fakeSession(), scanner });
    w.update(needs);
    q<HTMLButtonElement>(".hp-join-camera")?.click();
    await flush();
    w.update(stateOf({ kind: "starting", peerState: "loading-config" }));
    await flush();
    expect(scanner.stops).toBe(1);

    w.update(needs);
    q<HTMLButtonElement>(".hp-join-camera")?.click();
    await flush();
    w.destroy();
    widget = undefined;
    await flush();
    expect(scanner.stops).toBe(2);
  });

  it("a picture joins with its invitation, or says why it could not", async () => {
    const session = fakeSession();
    const scanner = fakeScanner();
    const w = mount({ session, scanner });
    w.update(needs);
    const input = q<HTMLInputElement>(".hp-join-file input");
    if (input == null) throw new Error("no file input");
    const pick = async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File(["x"], "qr.png", { type: "image/png" })],
      });
      input.dispatchEvent(new Event("change"));
      await flush();
      await flush();
    };
    await pick();
    expect(session.calls).toEqual(["join:eyJfromfile"]);

    scanner.scanFile.mockResolvedValueOnce({ ok: false, reason: "no-qr" });
    await pick();
    expect(text(".hp-join-error")).toMatch(/no QR code/i);

    scanner.scanFile.mockResolvedValueOnce({ ok: false, reason: "not-accepted" });
    await pick();
    expect(text(".hp-join-error")).toMatch(/not an invitation/i);
    expect(session.calls).toEqual(["join:eyJfromfile"]);
  });
});

describe("compact", () => {
  it("is a status line and a menu of the leaving controls, with no form", () => {
    const w = mount({ session: fakeSession(), compact: true });
    w.update(stateOf({ kind: "live", joinedBy: "redeemed", note: null }));
    expect(q(".hp-join")?.classList.contains("hp-join-compact")).toBe(true);
    expect(q(".hp-join-form")).toBeNull();
    expect(text(".hp-join-phase")).toBe("Connected (relay)");
    // Exactly one live region says the link mode: a page that checks it by role must find one.
    const statuses = [...container.querySelectorAll('[role="status"]')].filter((n) =>
      /Connected \(relay\)/.test(n.textContent ?? ""),
    );
    expect(statuses.length).toBe(1);
    expect(q("details.hp-join-menu summary")).not.toBeNull();
    expect(q("details.hp-join-menu .hp-join-disconnect")).not.toBeNull();
    expect(q("details.hp-join-menu .hp-join-reset")).not.toBeNull();
  });
});

describe("mounting", () => {
  it("injects its stylesheet once per document, and destroy removes the widget", () => {
    const a = mountJoinWidget(container, { session: fakeSession(), scanner: null });
    const b = mountJoinWidget(container, { session: fakeSession(), scanner: null });
    expect(document.querySelectorAll("style#hp-join-style").length).toBe(1);
    expect(container.querySelectorAll(".hp-join").length).toBe(2);
    a.destroy();
    b.destroy();
    expect(container.querySelectorAll(".hp-join").length).toBe(0);
  });

  it("can leave the stylesheet to the page", () => {
    mount({ session: fakeSession(), injectStyles: false });
    expect(document.getElementById("hp-join-style")).toBeNull();
  });

  it("takes an initial state", () => {
    mount({
      session: fakeSession(),
      state: stateOf({ kind: "disconnected", message: "m" }),
    });
    expect(shown(".hp-join-reconnect")).toBe(true);
  });

  it("gives every instance its own ids", () => {
    const a = mountJoinWidget(container, { session: fakeSession(), scanner: null });
    const b = mountJoinWidget(container, { session: fakeSession(), scanner: null });
    const ids = [...container.querySelectorAll("[id]")].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    a.destroy();
    b.destroy();
  });
});

describe("describePhase", () => {
  it("is the status text, reusable outside the widget", () => {
    expect(describePhase(stateOf({ kind: "live", joinedBy: "redeemed", note: null }))).toBe(
      "Connected (relay)",
    );
    expect(describePhase(null)).toMatch(/starting/i);
  });
});
