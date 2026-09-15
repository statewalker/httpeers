/**
 * `mesh.html`: join an httpeers mesh, find the hub's LLM service, and open the same chat the
 * standalone page uses (spec §7).
 *
 *   1. Session: resume, or join from `?join=` or a pasted link/blob; the phases are shown.
 *   2. Live: find the advert `{ id: "llm", kind: "openapi-service" }` in the mesh view.
 *   3. Read its `openapi.json`: the base URL and the key header (`discoverLlm`).
 *   4. Store them in the "mesh" config, keeping a key stored earlier.
 *   5. No key yet: paste one, or request one from the hub (admins only; a member sees the 403).
 *   6. The chat, with the link mode and, for an admin, the LiteLLM dashboard link in its header.
 *
 * THE ONE PAGE THAT REACHES HTTPEERS. Everything mesh-specific is here and in `../mesh/`; the chat
 * itself is `ChatApp` unchanged, handed a different config store.
 */

import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
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
  | { kind: "key"; service: LlmService; config: ChatConfig }
  | { kind: "chat"; service: LlmService };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeStarting(state: SessionState): string {
  const { phase } = state;
  if (phase.kind === "starting") return phase.peerState;
  return phase.kind;
}

function SessionPanel({
  state,
  session,
}: {
  state: SessionState | null;
  session: PeerSession | null;
}) {
  const [invitation, setInvitation] = useState("");
  const phase = state?.phase;
  const joining = phase == null || phase.kind === "checking" || phase.kind === "starting";
  const message =
    phase != null && "message" in phase && typeof phase.message === "string" ? phase.message : null;

  const join = (event: FormEvent) => {
    event.preventDefault();
    const text = invitation.trim();
    if (text !== "") void session?.join(text);
  };

  return (
    <div className="flex flex-col gap-3">
      {joining && (
        <p role="status" className="text-sm text-gray-700">
          Joining…{" "}
          {state != null && <span className="text-gray-500">({describeStarting(state)})</span>}
        </p>
      )}
      {message != null && (
        <p
          role={phase?.kind === "needs-invitation" ? "note" : "alert"}
          className="text-sm text-gray-700"
        >
          {message}
        </p>
      )}
      {state?.controls.join && (
        <form className="flex flex-col gap-2" onSubmit={join}>
          <label className="flex flex-col gap-1 text-sm">
            Paste an invitation
            <textarea
              className={inputClass}
              rows={3}
              placeholder="a join link, a join blob, or an invitation id"
              value={invitation}
              onChange={(event) => setInvitation(event.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={invitation.trim() === ""}
            >
              Join
            </button>
          </div>
        </form>
      )}
      {state?.controls.reconnect && (
        <div className="flex justify-end">
          <button type="button" className={buttonClass} onClick={() => void session?.reconnect()}>
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}

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

function LinkStatus({ state }: { state: SessionState | null }) {
  if (state?.phase.kind !== "live" || state.hubLink == null) return null;
  return (
    <span role="status" className="text-xs text-gray-600">
      {state.hubLink === "relay" ? "Connected (relay)" : "Connected (direct)"}
    </span>
  );
}

function DashboardLink({ href }: { href: string }) {
  return (
    <a className="text-xs text-blue-700 underline" href={href} target="_blank" rel="noopener">
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
    setStage({ kind: "finding" });
    try {
      let advert = findLlmAdvert(handle.meshView());
      for (let waited = 0; advert == null && waited < ADVERT_WAIT_MS; waited += 500) {
        await sleep(500);
        advert = findLlmAdvert(handle.meshView());
      }
      if (advert == null) {
        setStage({ kind: "unavailable", message: "This mesh has no LLM service advertised." });
        return;
      }
      const edgeBase = new URL(handle.baseUrl ?? "/peers/", location.href).href;
      const service = await discoverLlm(pageFetch, edgeBase, advert.peerId);
      const config = meshConfig(await configStore.get(), service);
      await configStore.set(config);
      setStage(
        config.apiKey == null || config.apiKey === ""
          ? { kind: "key", service, config }
          : { kind: "chat", service },
      );
    } catch (error) {
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
            <LinkStatus state={state} />
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
          <LinkStatus state={state} />
          {dashboard}
        </header>
        {fatal != null && (
          <p role="alert" className="text-sm text-red-700">
            {fatal}
          </p>
        )}
        {stage.kind === "session" && <SessionPanel state={state} session={sessionRef.current} />}
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
              await configStore.set({ ...stage.config, apiKey: key });
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
