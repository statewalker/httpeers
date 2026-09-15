/**
 * The conversation logic, with no React in it: send, regenerate, edit, cancel.
 *
 * The session store is the source of truth. While a reply streams, the visible session carries the
 * partial reply; the store is written when the stream ends, fails or is cancelled, keeping whatever
 * text arrived.
 */

import {
  describeError,
  type EndpointConfig,
  type ErrorNotice,
  isAbort,
  streamChat,
} from "./openai-client.js";
import { type ChatMessage, type Session, type SessionStore, titleFrom } from "./sessions.js";

export interface ChatClient {
  stream(request: {
    model: string;
    messages: readonly ChatMessage[];
    signal: AbortSignal;
  }): AsyncIterable<string>;
}

export interface ChatState {
  session: Session | null;
  isRunning: boolean;
  error: ErrorNotice | null;
}

export class ChatBusyError extends Error {
  constructor() {
    super("A reply is still streaming.");
    this.name = "ChatBusyError";
  }
}

export class NoModelError extends Error {
  constructor() {
    super("No model is selected.");
    this.name = "NoModelError";
  }
}

export interface ChatControllerInit {
  sessions: SessionStore;
  client: ChatClient;
  /** The model to call for a session (null before the first message). */
  resolveModel: (session: Session | null) => string | undefined;
  /** After every write, so a session list can refresh. */
  onSaved?: (session: Session) => void;
}

export interface ChatController {
  getState(): ChatState;
  subscribe(listener: () => void): () => void;
  /** Show a stored session, or none (`null`: the next send creates one). */
  open(id: string | null): Promise<void>;
  send(text: string): Promise<void>;
  /** Replace the last assistant reply with a new one. */
  regenerate(): Promise<void>;
  /** Replace the user message at `index`, drop everything after it, and send again. */
  edit(index: number, text: string): Promise<void>;
  cancel(): void;
  setModel(model: string): Promise<void>;
  dismissError(): void;
}

export function createChatController(init: ChatControllerInit): ChatController {
  let state: ChatState = { session: null, isRunning: false, error: null };
  const listeners = new Set<() => void>();
  let abort: AbortController | null = null;

  const set = (patch: Partial<ChatState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const save = async (id: string, patch: Partial<Session>): Promise<Session> => {
    const saved = await init.sessions.update(id, patch);
    init.onSaved?.(saved);
    return saved;
  };

  /** One operation at a time. Every failure except a busy refusal becomes the error notice. */
  const exclusive = async (work: () => Promise<void>): Promise<void> => {
    if (state.isRunning) throw new ChatBusyError();
    set({ isRunning: true, error: null });
    try {
      await work();
    } catch (error) {
      set({ error: describeError(error) });
    } finally {
      abort = null;
      set({ isRunning: false });
    }
  };

  /** Stream a reply to `session`'s messages, then save whatever arrived. */
  const reply = async (session: Session): Promise<void> => {
    const model = init.resolveModel(session);
    if (model == null) throw new NoModelError();
    const controller = new AbortController();
    abort = controller;
    const history = session.messages;
    const showing = (content: string): Session => ({
      ...session,
      messages: [...history, { role: "assistant", content }],
    });

    let text = "";
    let failure: unknown = null;
    set({ session: showing("") });
    try {
      const deltas = init.client.stream({ model, messages: history, signal: controller.signal });
      for await (const delta of deltas) {
        if (controller.signal.aborted) break;
        text += delta;
        set({ session: showing(text) });
      }
    } catch (error) {
      if (!isAbort(error)) failure = error;
    }

    const messages: ChatMessage[] =
      text === "" ? history : [...history, { role: "assistant", content: text }];
    set({ session: await save(session.id, { messages, model }) });
    if (failure != null) throw failure;
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open(id) {
      if (state.isRunning) throw new ChatBusyError();
      const session = id == null ? null : await init.sessions.get(id);
      set({ session, error: null });
    },

    send: (text) =>
      exclusive(async () => {
        const content = text.trim();
        if (content === "") return;
        const session =
          state.session ??
          (await init.sessions.create({
            title: titleFrom(content),
            model: init.resolveModel(null),
          }));
        const saved = await save(session.id, {
          messages: [...session.messages, { role: "user", content }],
        });
        set({ session: saved });
        await reply(saved);
      }),

    regenerate: () =>
      exclusive(async () => {
        const session = state.session;
        if (session == null) return;
        const last = session.messages.at(-1);
        const messages =
          last?.role === "assistant" ? session.messages.slice(0, -1) : session.messages;
        if (messages.at(-1)?.role !== "user") return;
        const saved = await save(session.id, { messages });
        set({ session: saved });
        await reply(saved);
      }),

    edit: (index, text) =>
      exclusive(async () => {
        const session = state.session;
        const content = text.trim();
        if (session == null || content === "" || session.messages[index]?.role !== "user") return;
        const saved = await save(session.id, {
          messages: [...session.messages.slice(0, index), { role: "user", content }],
        });
        set({ session: saved });
        await reply(saved);
      }),

    cancel() {
      abort?.abort();
    },

    async setModel(model) {
      const session = state.session;
      if (session == null || state.isRunning) return;
      set({ session: await save(session.id, { model }) });
    },

    dismissError() {
      set({ error: null });
    },
  };
}

/** A `ChatClient` over whatever endpoint the config holds at call time. */
export function endpointClient(getConfig: () => EndpointConfig | null): ChatClient {
  return {
    stream({ model, messages, signal }) {
      const config = getConfig();
      if (config == null) throw new Error("No endpoint is configured.");
      return streamChat({ config, model, messages, signal });
    },
  };
}
