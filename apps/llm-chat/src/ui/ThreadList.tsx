import type { SessionSummary } from "../core/sessions.js";

export interface ThreadListProps {
  sessions: SessionSummary[];
  activeId: string | null;
  disabled: boolean;
  onNew(): void;
  onSelect(id: string): void;
  onDelete(id: string): void;
}

export function ThreadList({
  sessions,
  activeId,
  disabled,
  onNew,
  onSelect,
  onDelete,
}: ThreadListProps) {
  return (
    <nav
      aria-label="Conversations"
      className="flex w-64 shrink-0 flex-col gap-2 border-r border-gray-200 p-2"
    >
      <button
        type="button"
        className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50"
        disabled={disabled}
        onClick={onNew}
      >
        New chat
      </button>
      <ul className="flex flex-col gap-0.5 overflow-y-auto">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center">
            <button
              type="button"
              aria-current={session.id === activeId ? "true" : undefined}
              className="flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-gray-100 disabled:opacity-50 aria-[current=true]:bg-gray-200"
              disabled={disabled}
              onClick={() => onSelect(session.id)}
            >
              {session.title}
            </button>
            <button
              type="button"
              aria-label={`Delete ${session.title}`}
              className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              disabled={disabled}
              onClick={() => onDelete(session.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
