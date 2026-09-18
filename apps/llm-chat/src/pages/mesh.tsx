/**
 * `mesh.html`: join an httpeers mesh, find the hub's LLM service, and open the same chat the
 * standalone page uses (spec §7).
 *
 *   1. Session: resume, or join from `?join=`, a pasted link/blob or a scanned QR code. The join
 *      form, the phases and the leaving controls are `@statewalker/httpeers-join`'s widget, shared
 *      with the demo pages (`../mesh/join-widget.tsx`).
 *   2. Live: find the HUB's advert `{ id: "llm", kind: "openapi-service" }` in the mesh view. The
 *      same advert from any other peer is ignored: a member could advertise it to collect keys.
 *   3. Read the hub's `openapi.json`: the base URL and the key header (`discoverLlm`, which refuses
 *      any URL outside `<edge><hubPeerId>/llm/`).
 *   4. Store them in the "mesh" config, keeping a key stored earlier for the same endpoint only.
 *   5. No key yet: paste one, or request one from the hub (admins only; a member sees the 403).
 *   6. The chat, with the link mode (the widget's compact mode, whose menu holds Disconnect and
 *      Leave) and, for an admin, the LiteLLM dashboard link in its header.
 *
 * THE ONE PAGE THAT REACHES HTTPEERS. Everything mesh-specific is here and in `../mesh/`; the chat
 * itself is `ChatApp` unchanged, handed a different config store.
 */

import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChatConfig } from "../core/config.js";
import { idbConfigStore, idbSessionStore } from "../core/idb.js";
import {
  DiscoveryError,
  discoverLlm,
  findLlmAdvert,
  isMeshAdmin,
  KeyRequestError,
  type LlmService,
  meshConfig,
  mintKey,
} from "../mesh/discover.js";
import { JoinWidgetView } from "../mesh/join-widget.js";
import { startMeshSession } from "../mesh/session.js";
import { ChatApp } from "../ui/ChatApp.js";
import { buttonClass, inputClass, primaryButtonClass } from "../ui/Modal.js";
import "../ui/styles.css";

const configStore = idbConfigStore("mesh");
const sessionStore = idbSessionStore();

/** Wrapped, never passed bare: `window.fetch` called unbound throws "Illegal invocation". */
const pageFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** How long a live member waits for the hub's advert to appear in its mesh view. */
const ADVERT_WAIT_MS = 30_000;

type Stage =
  | { kind: "session" }
  | { kind: "finding" }
  | { kind: "unavailable"; message: string }
  /** `run`: the discovery run that produced this step; a key arriving after a newer run is dropped. */
  | { kind: "key"; service: LlmService; config: ChatConfig; run: number }
  | { kind: "chat"; service: LlmService };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function KeyStep({
  stage,
  onKey,
  onMinted,
  onRefused,
}: {
  stage: Extract<Stage, { kind: "key" }>;
  onKey(key: string): Promise<void>;
  onMinted(): void;
  onRefused(): void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const request = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const minted = await mintKey(pageFetch, stage.service.serviceBase);
      onMinted();
      await onKey(minted);
    } catch (error) {
      if (error instanceof KeyRequestError && error.status === 403) onRefused();
      setFailure(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim() !== "") void onKey(key.trim());
      }}
    >
      <p className="text-sm text-gray-700">
        The mesh's LLM service needs a key of its own. Paste the key an admin gave you
        {stage.service.canMintKeys ? ", or request one if you are an admin" : ""}.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Key
        <input
          className={inputClass}
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      {failure != null && (
        <p role="alert" className="text-sm text-red-700">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {stage.service.canMintKeys && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void request()}
          >
            Request a key
          </button>
        )}
        <button type="submit" className={primaryButtonClass} disabled={busy || key.trim() === ""}>
          Use key
        </button>
      </div>
    </form>
  );
}

function DashboardLink({ href }: { href: string }) {
  return (
    <a
      className="text-xs text-blue-700 underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      LiteLLM dashboard
    </a>
  );
}

function MeshPage() {
  const [state, setState] = useState<SessionState | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "session" });
  const [fatal, setFatal] = useState<string | null>(null);
  /** `true` once a key request succeeded, `false` once it was refused, `null` before either. */
  const [mintOutcome, setMintOutcome] = useState<boolean | null>(null);
  const sessionRef = useRef<PeerSession | null>(null);
  /** The handle discovery last ran for: a new join or reconnect gets a new handle, and runs it again. */
  const discoveredFor = useRef<unknown>(null);
  /**
   * Bumped by every discovery start and by leaving live. A run whose number is no longer current
   * writes nothing — no config, no stage — so an old handle's discovery (or a superseded "Try
   * again") can never overwrite what a newer one decided.
   */
  const discoveryRun = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const relayDocUrl = new URLSearchParams(location.search).get("relayDoc") ?? undefined;
    startMeshSession({ onChange: setState, relayDocUrl }).then(
      ({ session, started }) => {
        sessionRef.current = session;
        setState(session.state());
        started.catch((error: unknown) => setFatal(String(error)));
        // Nothing pushes the mesh view: it arrives on the heartbeat. Re-reading the state on a
        // timer is what shows the advert and this member's roles as they arrive.
        timer = setInterval(() => setState(session.state()), 2_000);
      },
      (error: unknown) => setFatal(String(error)),
    );
    return () => clearInterval(timer);
  }, []);

  const discover = useCallback(async (live: SessionState) => {
    const handle = live.handle;
    if (handle == null) return;
    const run = ++discoveryRun.current;
    const current = () => discoveryRun.current === run;
    setStage({ kind: "finding" });
    try {
      // Only the hub is trusted with the key: the advert must be the hub's own, and discovery
      // reads the hub's document whoever else advertises `llm`.
      const hubPeerId = handle.hubPeerId;
      let advert = findLlmAdvert(handle.meshView(), hubPeerId);
      for (let waited = 0; advert == null && waited < ADVERT_WAIT_MS; waited += 500) {
        await sleep(500);
        if (!current()) return;
        advert = findLlmAdvert(handle.meshView(), hubPeerId);
      }
      if (!current()) return;
      if (advert == null) {
        setStage({ kind: "unavailable", message: "This mesh's hub advertises no LLM service." });
        return;
      }
      const edgeBase = new URL(handle.baseUrl ?? "/peers/", location.href).href;
      const service = await discoverLlm(pageFetch, edgeBase, hubPeerId);
      if (!current()) return;
      const config = meshConfig(await configStore.get(), service);
      if (!current()) return;
      await configStore.set(config);
      if (!current()) return;
      setStage(
        config.apiKey == null || config.apiKey === ""
          ? { kind: "key", service, config, run }
          : { kind: "chat", service },
      );
    } catch (error) {
      if (!current()) return;
      const message =
        error instanceof DiscoveryError || error instanceof Error ? error.message : String(error);
      setStage({ kind: "unavailable", message });
    }
  }, []);

  const phaseKind = state?.phase.kind;
  const handle = state?.handle ?? null;
  useEffect(() => {
    if (phaseKind !== "live" || handle == null) {
      discoveredFor.current = null;
      discoveryRun.current++;
      setStage({ kind: "session" });
      return;
    }
    if (discoveredFor.current === handle) return;
    discoveredFor.current = handle;
    // A spent invitation must not be retried on reload: the member now resumes from memory.
    const url = new URL(location.href);
    if (url.searchParams.has("join")) {
      url.searchParams.delete("join");
      history.replaceState(null, "", url);
    }
    if (state != null) void discover(state);
  }, [phaseKind, handle, state, discover]);

  const admin = mintOutcome ?? isMeshAdmin(handle?.meshView() ?? null);
  const session = sessionRef.current;
  // The header's link status, with Disconnect and Leave in its menu, while the page is past joining.
  const linkStatus =
    session != null && phaseKind === "live" ? (
      <JoinWidgetView session={session} state={state} compact />
    ) : null;
  const dashboard =
    admin && (stage.kind === "chat" || stage.kind === "key") ? (
      <DashboardLink href={stage.service.dashboardUrl} />
    ) : null;

  if (stage.kind === "chat") {
    return (
      <ChatApp
        configStore={configStore}
        sessionStore={sessionStore}
        title="LLM chat"
        headerExtra={
          <>
            {linkStatus}
            {dashboard}
          </>
        }
      />
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-gray-50 p-4 text-gray-900">
      <main className="mt-12 flex w-full max-w-md flex-col gap-4 rounded-lg bg-white p-5 shadow">
        <header className="flex items-center gap-3">
          <h1 className="flex-1 text-lg font-semibold">LLM chat on the mesh</h1>
          {linkStatus}
          {dashboard}
        </header>
        {fatal != null && (
          <p role="alert" className="text-sm text-red-700">
            {fatal}
          </p>
        )}
        {stage.kind === "session" &&
          (session != null ? (
            <JoinWidgetView session={session} state={state} />
          ) : (
            <p role="status" className="text-sm text-gray-700">
              Starting…
            </p>
          ))}
        {stage.kind === "finding" && (
          <p role="status" className="text-sm text-gray-700">
            Finding the LLM service…
          </p>
        )}
        {stage.kind === "unavailable" && (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-red-700">
              {stage.message}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  if (state != null) void discover(state);
                }}
              >
                Try again
              </button>
            </div>
          </div>
        )}
        {stage.kind === "key" && (
          <KeyStep
            stage={stage}
            onMinted={() => setMintOutcome(true)}
            onRefused={() => setMintOutcome(false)}
            onKey={async (key) => {
              if (discoveryRun.current !== stage.run) return;
              await configStore.set({ ...stage.config, apiKey: key });
              if (discoveryRun.current !== stage.run) return;
              setStage({ kind: "chat", service: stage.service });
            }}
          />
        )}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root == null) throw new Error("mesh.html has no #root element");
createRoot(root).render(<MeshPage />);
