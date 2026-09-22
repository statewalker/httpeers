/**
 * The whole chat: start-up gating, the dialogs, the session list and the conversation.
 *
 * It takes its stores as props and imports nothing from httpeers, so the mesh page can hand it a
 * different, pre-filled `ConfigStore` and reuse it unchanged.
 */

import { Slots } from "@statewalker/shared-slots";
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
import { listModels } from "../core/openai-client.js";
import type { SessionStore, SessionSummary } from "../core/sessions.js";
import { SlotsProvider } from "../slots/context.js";
import { settingsPanelsSlot } from "../slots/panels.js";
import { ModelPicker } from "./ModelPicker.js";
import { ConnectionPanel } from "./panels/ConnectionPanel.js";
import { ModelsPanel } from "./panels/ModelsPanel.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { Thread } from "./Thread.js";
import { ThreadList } from "./ThreadList.js";
import { useChatState } from "./use-chat-state.js";

/** Registered-panel ids, shared between the registration below and `initialPanelId`. */
const CONNECTION_PANEL_ID = "connection";
const MODELS_PANEL_ID = "models";

export interface ChatAppProps {
  configStore: ConfigStore;
  sessionStore: SessionStore;
  title?: string;
  /** Rendered in the header before the settings button: the mesh page's link status and links. */
  headerExtra?: ReactNode;
}

export function ChatApp({ configStore, sessionStore, title = "Chat", headerExtra }: ChatAppProps) {
  /** `undefined` while the stored config is still loading. */
  const [config, setConfig] = useState<ChatConfig | null | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

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

  /**
   * The dialog this app fills through `settingsPanelsSlot`: Connection and Models, one tab each.
   * Local to this `ChatApp` instance for now -- Task 6 moves this bus (and the registration below)
   * up to an app shell, which is what lets `mesh.html` add Sharing and Keys (Task 11) alongside
   * these same two.
   *
   * The registered `Component`s take no props (the slot contract), so they read the live config
   * through `configRef` rather than closing over `config` -- keeping this effect's dependencies
   * stable means the panels are registered once, not torn down and rebuilt (and their in-progress
   * form state lost) on every render.
   */
  const slots = useMemo(() => new Slots(), []);

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
      <div className="flex h-screen flex-col text-gray-900">
        <div
          className="flex min-h-0 flex-1 flex-col"
          inert={showSettings}
          aria-hidden={showSettings}
        >
          <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-2">
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
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              className="rounded px-2 py-1 hover:bg-gray-100"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
          </header>

          <div className="flex min-h-0 flex-1">
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
            <main className="min-w-0 flex-1">
              <Thread controller={controller} />
            </main>
          </div>
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
      </div>
    </SlotsProvider>
  );
}
