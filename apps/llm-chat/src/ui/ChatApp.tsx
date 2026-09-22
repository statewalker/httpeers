/**
 * The whole chat: start-up gating, the dialogs, the session list and the conversation.
 *
 * It takes its stores as props and imports nothing from httpeers, so the mesh page can hand it a
 * different, pre-filled `ConfigStore` and reuse it unchanged.
 */

import { Slots } from "@statewalker/shared-slots";
import { SettingsIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChatController, endpointClient } from "../core/chat-controller.js";
import {
  applyEndpoint,
  applyModels,
  type ChatConfig,
  type ConfigStore,
  refreshModels,
  resolveModel,
  startupStep,
} from "../core/config.js";
import { judgeConfigUrl } from "../core/config-trust.js";
import {
  type ExternalConfig,
  fetchExternalConfig,
  resolveConfig,
} from "../core/external-config.js";
import { listModels } from "../core/openai-client.js";
import type { SessionStore, SessionSummary } from "../core/sessions.js";
import { SlotsProvider } from "../slots/context.js";
import { settingsPanelsSlot } from "../slots/panels.js";
import { AppShell } from "./AppShell.js";
import { ConfirmConfigDialog } from "./ConfirmConfigDialog.js";
import { ModelPicker } from "./ModelPicker.js";
import { ConnectionPanel } from "./panels/ConnectionPanel.js";
import { ModelsPanel } from "./panels/ModelsPanel.js";
import { Button } from "./primitives/button.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { Composer, Thread } from "./Thread.js";
import { ThreadList } from "./ThreadList.js";
import { useChatState } from "./use-chat-state.js";

/** Registered-panel ids, shared between the registration below and `initialPanelId`. */
const CONNECTION_PANEL_ID = "connection";
const MODELS_PANEL_ID = "models";

/** `window.fetch` called unbound throws "Illegal invocation"; this is the default `fetchImpl`. */
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** A `?config=` document read but not yet accepted, waiting on `ConfirmConfigDialog`. */
interface PendingExternalConfig {
  url: string;
  /** The origin to show the user -- never the WHATWG opaque `"null"`; see `ConfirmConfigDialog`. */
  origin: string;
  external: ExternalConfig;
}

/**
 * `Date.now()`, refreshed every second while `active` -- feeds `Thread`'s elapsed-seconds
 * counter. Idle when not `active`, so the waiting bubble isn't ticking a component that isn't
 * rendered.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export interface ChatAppProps {
  configStore: ConfigStore;
  sessionStore: SessionStore;
  title?: string;
  /** Rendered in the header before the settings button: the mesh page's link status and links. */
  headerExtra?: ReactNode;
  /**
   * The confirmed mesh edge base, once `mesh.html`'s discovery has found it; `null` on the
   * standalone page. This is *why* a `?config=` arriving before discovery is held rather than
   * fetched: `mesh.html` only ever mounts `ChatApp` once discovery has already succeeded (before
   * that it shows the join/finding/key screens instead), so by construction this prop is never
   * `null` on the mesh page by the time `?config=` handling below runs.
   */
  edgeBase?: string | null;
  /** Injected by tests; defaults to `window.fetch`, bound so it is never called unbound. */
  fetchImpl?: typeof fetch;
  /**
   * An externally created slots bus to register `settingsPanelsSlot` panels into, shared with
   * whoever else contributes tabs -- `mesh.html`'s Sharing and Keys (Task 11), registered by
   * `registerMeshPanels` before this component ever mounts. Omitted (the standalone page): a
   * private instance, as before, so `index.html` still shows exactly the two panels this
   * component registers itself.
   */
  slots?: Slots;
}

export function ChatApp({
  configStore,
  sessionStore,
  title = "Chat",
  headerExtra,
  edgeBase = null,
  fetchImpl = defaultFetch,
  slots: externalSlots,
}: ChatAppProps) {
  /** `undefined` while the stored config is still loading. */
  const [config, setConfig] = useState<ChatConfig | null | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** A visible, non-fatal notice about `?config=` handling: a failure, or an explicit rejection. */
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  /** An untrusted `?config=` document, fetched and parsed, awaiting the user's decision. */
  const [pendingExternal, setPendingExternal] = useState<PendingExternalConfig | null>(null);

  // The controller outlives renders; it reads the current config through this ref.
  const configRef = useRef<ChatConfig | null>(null);
  configRef.current = config ?? null;

  const refreshSessions = useCallback(async () => {
    setSessions(await sessionStore.list());
  }, [sessionStore]);

  const controller = useMemo(
    () =>
      createChatController({
        sessions: sessionStore,
        client: endpointClient(() => configRef.current),
        resolveModel: (session) => resolveModel(configRef.current, session?.model),
        onSaved: () => void refreshSessions(),
      }),
    [sessionStore, refreshSessions],
  );
  const chat = useChatState(controller);
  const now = useNow(chat.isRunning);

  useEffect(() => {
    void configStore.get().then(setConfig);
    void refreshSessions();
  }, [configStore, refreshSessions]);

  const saveConfig = useCallback(
    async (next: ChatConfig): Promise<void> => {
      await configStore.set(next);
      setConfig(next);
    },
    [configStore],
  );

  /** Drops `?config=` from the address bar once it has been resolved, one way or another. */
  const stripConfigParam = useCallback(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("config")) return;
    url.searchParams.delete("config");
    history.replaceState(null, "", url);
  }, []);

  /**
   * Applies a fetched, parsed `?config=` document -- the shared tail of both the trusted path and
   * an accepted confirmation. `resolveConfig` (Task 8) makes the saved value win when one already
   * exists, so this is safe to call unconditionally; it becomes a same-value no-op rather than
   * silently overwriting an endpoint the user typed in by hand.
   *
   * ON THE MESH PAGE THIS IS DELIBERATE, NOT INCIDENTAL: `mesh.tsx`'s `discover()` already saves
   * the endpoint it read from the hub's own advertisement before `ChatApp` ever mounts, so
   * `configRef.current` is never null there and a `?config=` document's `baseUrl` never wins.
   * That is the point, not a side effect of "saved wins" happening to be true -- a URL parameter
   * that could redirect the chat away from the hub it just joined, onto an attacker's endpoint
   * carrying the mesh's own key header, is exactly the substitution `discover.ts`'s "trust only
   * the hub" rule (and Task 9's same-origin-skipped-once-`edgeBase`-is-set rule) exists to
   * prevent. `?config=` is a first-boot / hand-a-link mechanism for the STANDALONE page; on the
   * mesh page the discovered endpoint always takes precedence. See
   * `tests/chat-app.test.tsx`'s "does not let a ?config= document override the endpoint
   * discovered from the hub" for the pinned behaviour.
   *
   * CARRY-FORWARD: `ExternalConfig.defaultModel` is parsed and validated (Task 8) but
   * `applyEndpoint` has no such field, so `resolveConfig` alone drops it on the floor. This is the
   * one place holding both the parsed document and a real model list, so it feeds `defaultModel`
   * in as the candidate default for `refreshModels` right after `GET /models` -- the same function
   * the model-picker's "Refresh" already uses, not a new mechanism. `refreshModels` keeps that
   * candidate only if the endpoint actually serves it, and otherwise falls back to its own first
   * model, exactly as the picker's refresh does for a default that stopped existing.
   */
  const applyExternalConfig = useCallback(
    async (external: ExternalConfig): Promise<void> => {
      const resolved = resolveConfig({ saved: configRef.current, external });
      if (resolved.config == null) return;
      let next = resolved.config;
      if (resolved.source === "external" && external.defaultModel != null) {
        try {
          const models = await listModels(
            { baseUrl: next.baseUrl, apiKey: next.apiKey, apiKeyHeader: next.apiKeyHeader },
            { fetchImpl },
          );
          next = refreshModels({ ...next, defaultModel: external.defaultModel }, models);
        } catch {
          // The endpoint is still usable without a model list yet -- the normal "models" startup
          // step picks up from here, same as for a document with no defaultModel at all.
        }
      }
      await saveConfig(next);
      stripConfigParam();
    },
    [saveConfig, stripConfigParam, fetchImpl],
  );

  /**
   * `?config=`, read once per mount. Trusted -> fetch, parse and apply directly. Untrusted -> hand
   * off to `ConfirmConfigDialog` (rendered below) with both the origin and the endpoint it wants,
   * never the WHATWG opaque `"null"` a non-http(s)/cross-mount origin can produce. Any failure --
   * network, parse, validation -- becomes a visible, non-fatal notice; `config` itself is never
   * touched on failure, so the page falls back to whatever it already had: a saved config, or the
   * settings screen `startupStep` already shows for no config at all.
   *
   * `judgeConfigUrl` runs before the fetch (it is pure and free), but the fetch itself happens
   * either way: `ConfirmConfigDialog` must name the endpoint the document wants
   * (carry-forward), and that is only known once the document has been read.
   */
  const handledConfigUrl = useRef(false);
  useEffect(() => {
    if (config === undefined) return;
    if (handledConfigUrl.current) return;
    handledConfigUrl.current = true;

    const configUrl = new URLSearchParams(location.search).get("config");
    if (configUrl == null) return;

    let cancelled = false;
    const verdict = judgeConfigUrl(configUrl, { pageUrl: location.href, edgeBase });

    (async () => {
      let external: ExternalConfig;
      try {
        external = await fetchExternalConfig(configUrl, fetchImpl);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setConfigNotice(`Could not use the config at ${configUrl}: ${message}`);
        return;
      }
      if (cancelled) return;

      if (verdict.trusted) {
        await applyExternalConfig(external);
        return;
      }
      const origin = verdict.origin === "null" ? configUrl : verdict.origin;
      setPendingExternal({ url: configUrl, origin, external });
    })();

    return () => {
      cancelled = true;
    };
  }, [config, edgeBase, fetchImpl, applyExternalConfig]);

  /**
   * The dialog this app fills through `settingsPanelsSlot`: Connection and Models, one tab each.
   * Local to this `ChatApp` instance for now -- `mesh.html` (Task 11) adds Sharing and Keys
   * alongside these same two, through the same bus.
   *
   * The registered `Component`s take no props (the slot contract), so they read the live config
   * through `configRef` rather than closing over `config` -- keeping this effect's dependencies
   * stable means the panels are registered once, not torn down and rebuilt (and their in-progress
   * form state lost) on every render.
   */
  const ownSlots = useMemo(() => new Slots(), []);
  const slots = externalSlots ?? ownSlots;

  useEffect(() => {
    const disposeConnection = slots.register(settingsPanelsSlot, CONNECTION_PANEL_ID, {
      id: CONNECTION_PANEL_ID,
      title: "Connection",
      order: 1,
      Component: () => (
        <ConnectionPanel
          initial={configRef.current}
          onSave={(endpoint) => void saveConfig(applyEndpoint(configRef.current, endpoint))}
        />
      ),
    });
    const disposeModels = slots.register(settingsPanelsSlot, MODELS_PANEL_ID, {
      id: MODELS_PANEL_ID,
      title: "Models",
      order: 2,
      Component: () => {
        const current = configRef.current;
        if (current == null || current.baseUrl === "") {
          return <p className="text-sm text-muted-foreground">Set a connection first.</p>;
        }
        return (
          <ModelsPanel
            endpoint={current}
            current={current.defaultModel}
            onPick={(models, picked) => {
              void saveConfig(applyModels(current, models, picked));
              void controller.setModel(picked);
            }}
          />
        );
      },
    });
    return () => {
      disposeConnection();
      disposeModels();
    };
  }, [slots, saveConfig, controller]);

  if (config === undefined) return <p className="p-4 text-gray-500">Loading…</p>;

  const step = startupStep(config);
  const model = resolveModel(config, chat.session?.model);
  /** Not yet a usable endpoint+model: the dialog is forced open and cannot be dismissed. */
  const startupBlocking = step !== "chat";
  const showSettings = startupBlocking || settingsOpen;
  const dismissible = !startupBlocking;

  return (
    <SlotsProvider slots={slots}>
      {configNotice != null && (
        <output className="flex items-center gap-3 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <p className="flex-1">{configNotice}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfigNotice(null)}>
            Dismiss
          </Button>
        </output>
      )}
      <div inert={showSettings} aria-hidden={showSettings}>
        <AppShell
          sidebar={
            <ThreadList
              sessions={sessions}
              activeId={chat.session?.id ?? null}
              disabled={chat.isRunning}
              onNew={() => void controller.open(null)}
              onSelect={(id) => void controller.open(id)}
              onDelete={async (id) => {
                await sessionStore.delete(id);
                if (chat.session?.id === id) await controller.open(null);
                await refreshSessions();
              }}
            />
          }
          header={
            <>
              <h1 className="flex-1 font-semibold">{title}</h1>
              {config != null && step === "chat" && (
                <ModelPicker
                  models={config.models}
                  value={model}
                  disabled={chat.isRunning}
                  onChange={(next) => {
                    void saveConfig({ ...config, defaultModel: next });
                    void controller.setModel(next);
                  }}
                  onRefresh={async () => {
                    await saveConfig(refreshModels(config, await listModels(config)));
                  }}
                />
              )}
              {headerExtra}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Settings"
                title="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <SettingsIcon />
              </Button>
            </>
          }
          composer={
            <Composer disabled={chat.isRunning} onSend={(text) => void controller.send(text)} />
          }
        >
          <Thread
            state={chat}
            now={now}
            onCancel={() => controller.cancel()}
            onSend={(text) => void controller.send(text)}
            onEdit={(index, text) => void controller.edit(index, text)}
            onRegenerate={() => void controller.regenerate()}
            onRegenerateFrom={(index) => void controller.regenerateFrom(index)}
            onDismissError={controller.dismissError}
          />
        </AppShell>
      </div>

      <SettingsDialog
        open={showSettings}
        initialPanelId={step === "models" ? MODELS_PANEL_ID : undefined}
        onOpenChange={(next) => {
          if (next) {
            setSettingsOpen(true);
            return;
          }
          if (!dismissible) return;
          setSettingsOpen(false);
        }}
      />

      {pendingExternal != null && (
        <ConfirmConfigDialog
          origin={pendingExternal.origin}
          baseUrl={pendingExternal.external.baseUrl}
          onAccept={() => {
            const { external } = pendingExternal;
            setPendingExternal(null);
            void applyExternalConfig(external);
          }}
          onReject={() => {
            setConfigNotice(`Ignored the config at ${pendingExternal.url}: it was not accepted.`);
            setPendingExternal(null);
          }}
        />
      )}
    </SlotsProvider>
  );
}
