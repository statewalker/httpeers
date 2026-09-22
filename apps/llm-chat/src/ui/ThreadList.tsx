import { XIcon } from "lucide-react";
import type { SessionSummary } from "../core/sessions.js";
import { Button } from "./primitives/button.js";
import { ScrollArea } from "./primitives/scroll-area.js";

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
    <nav aria-label="Conversations" className="flex h-full flex-col gap-2 p-2">
      <Button variant="outline" size="sm" disabled={disabled} onClick={onNew}>
        New chat
      </Button>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 pr-2">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-current={session.id === activeId ? "true" : undefined}
                className="flex-1 justify-start truncate font-normal aria-current:bg-accent"
                disabled={disabled}
                onClick={() => onSelect(session.id)}
              >
                <span className="truncate">{session.title}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete ${session.title}`}
                className="size-8 shrink-0 text-muted-foreground"
                disabled={disabled}
                onClick={() => onDelete(session.id)}
              >
                <XIcon className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </nav>
  );
}
