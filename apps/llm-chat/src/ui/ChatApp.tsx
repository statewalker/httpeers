/**
 * The whole chat: start-up gating, the dialogs, the session list and the conversation.
 *
 * It takes its stores as props and imports nothing from httpeers, so the mesh page can hand it a
 * different, pre-filled `ConfigStore` and reuse it unchanged.
 */

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
import { ModelDialog } from "./ModelDialog.js";
import { ModelPicker } from "./ModelPicker.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { Thread } from "./Thread.js";
import { ThreadList } from "./ThreadList.js";
import { useChatState } from "./use-chat-state.js";

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
  const [modelsOpen, setModelsOpen] = useState(false);
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

  const saveConfig = async (next: ChatConfig): Promise<void> => {
    await configStore.set(next);
    setConfig(next);
  };

  if (config === undefined) return <p className="p-4 text-gray-500">Loading…</p>;

  const step = startupStep(config);
  const model = resolveModel(config, chat.session?.model);
  const showSettings = step === "settings" || settingsOpen;
  const showModels =
    config != null && step !== "settings" && !settingsOpen && (step === "models" || modelsOpen);
  const blocked = showSettings || showModels;

  return (
    <div className="flex h-screen flex-col text-gray-900">
      <div className="flex min-h-0 flex-1 flex-col" inert={blocked} aria-hidden={blocked}>
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

      {showSettings && (
        <SettingsDialog
          initial={config}
          dismissible={step !== "settings"}
          onClose={() => setSettingsOpen(false)}
          onSave={(endpoint) => {
            void saveConfig(applyEndpoint(config, endpoint));
            setSettingsOpen(false);
          }}
        />
      )}
      {showModels && config != null && (
        <ModelDialog
          endpoint={config}
          current={config.defaultModel}
          dismissible={step === "chat"}
          onClose={() => setModelsOpen(false)}
          onChangeConnection={() => setSettingsOpen(true)}
          onPick={(models, picked) => {
            void saveConfig(applyModels(config, models, picked));
            void controller.setModel(picked);
            setModelsOpen(false);
          }}
        />
      )}
    </div>
  );
}
