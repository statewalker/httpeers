/**
 * Conversations, and the async store they live behind.
 *
 * Messages are stored in the OpenAI chat shape, so a stored session is exactly what the next
 * `/chat/completions` request sends. The UI library's own message shape never reaches storage.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Session {
  id: string;
  title: string;
  model?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type SessionSummary = Omit<Session, "messages">;
export type SessionInit = Partial<Omit<Session, "id" | "createdAt" | "updatedAt">>;
export type SessionPatch = Partial<Omit<Session, "id" | "createdAt">>;

export interface SessionStore {
  /** Newest `updatedAt` first, without messages. */
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<Session | null>;
  create(init?: SessionInit): Promise<Session>;
  /** Rejects with `SessionNotFoundError` for an unknown id. */
  update(id: string, patch: SessionPatch): Promise<Session>;
  /** Resolves for an unknown id too. */
  delete(id: string): Promise<void>;
}

export class SessionNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`No session with id ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export const DEFAULT_TITLE = "New chat";
export const TITLE_LENGTH = 60;

/** The first user message, on one line, cut to `TITLE_LENGTH` characters. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return DEFAULT_TITLE;
  return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1)}…`;
}

/** Injected by tests; defaults to the wall clock and random UUIDs. */
export interface StoreClock {
  now?: () => number;
  newId?: () => string;
}

export function storeClock(clock: StoreClock = {}): Required<StoreClock> {
  return {
    now: clock.now ?? (() => Date.now()),
    newId: clock.newId ?? (() => crypto.randomUUID()),
  };
}

export function newSession(init: SessionInit, clock: Required<StoreClock>): Session {
  const now = clock.now();
  return {
    id: clock.newId(),
    title: init.title ?? DEFAULT_TITLE,
    model: init.model,
    messages: init.messages ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

export function applyPatch(session: Session, patch: SessionPatch, now: number): Session {
  return {
    ...session,
    ...patch,
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: patch.updatedAt ?? now,
  };
}

export function summaryOf({ messages: _messages, ...summary }: Session): SessionSummary {
  return summary;
}

export function byRecency(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt;
}

export function memorySessionStore(clock?: StoreClock): SessionStore {
  const time = storeClock(clock);
  const rows = new Map<string, Session>();
  return {
    async list() {
      return [...rows.values()].map(summaryOf).sort(byRecency);
    },
    async get(id) {
      const row = rows.get(id);
      return row == null ? null : structuredClone(row);
    },
    async create(init = {}) {
      const session = newSession(init, time);
      rows.set(session.id, structuredClone(session));
      return session;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (row == null) throw new SessionNotFoundError(id);
      const next = applyPatch(row, patch, time.now());
      rows.set(id, structuredClone(next));
      return next;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}
