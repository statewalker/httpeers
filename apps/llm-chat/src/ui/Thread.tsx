/**
 * The conversation, rendered by assistant-ui over OUR state.
 *
 * `Thread` is self-contained: it takes `ChatState` (Task 2's `phase`/`runStartedAt` included) and a
 * handful of callbacks, and builds its own `useExternalStoreRuntime` from them -- it does not take
 * a `ChatController` directly, so it can be rendered and asserted against in isolation (see
 * `tests/thread.test.tsx`, which renders it with no surrounding `AssistantRuntimeProvider` of its
 * own). `now` is a prop, not a `Date.now()` call, so the elapsed-seconds counter in the waiting
 * bubble is testable without fake timers.
 *
 * Three phases, three renderings, replacing the old `ThreadPrimitive.If running` split:
 *   - `idle`      -- no indicator, no Stop.
 *   - `waiting`   -- request sent, nothing back yet. A placeholder bubble
 *                    (`data-testid="waiting-indicator"`, `aria-live="polite"`) with an elapsed
 *                    whole-seconds counter, and Stop. On a local llama.cpp model this can
 *                    legitimately run 30s+ (cold load, prompt processing) -- the counter is what
 *                    tells a human "this is working", not "this hung".
 *   - `streaming` -- the partial reply is rendered by `ThreadPrimitive.Messages` itself; the
 *                    placeholder is gone, Stop stays.
 *
 * `Composer` (also exported here, not its own file -- the brief's file list only names this one)
 * is `Thread`'s composer, pulled out so `ChatApp` can pass it through `AppShell`'s `composer` slot
 * instead of leaving that sticky, safe-area-padded footer region dead (see that file's docblock).
 * It is deliberately plain React, not `ComposerPrimitive`: `ComposerPrimitive.Input`/`Send` read
 * their state from the same `AssistantRuntimeProvider` context `Thread` owns, and that provider is
 * private to `Thread` precisely so `Thread` can stay self-contained per the props above. Standing
 * up a second, independent assistant-ui runtime purely to render a textarea seemed like more
 * machinery than the job needs; a controlled textarea calling `onSend` directly does the same job
 * with far less surface.
 *
 * Why this is hand-rolled on raw primitives rather than assistant-ui's `r.assistant-ui.com/thread`
 * shadcn-registry component (Fix round 1: actually tried, not assumed): `pnpm dlx shadcn@latest add
 * "https://r.assistant-ui.com/thread" --overwrite` installs cleanly against React 19.3.0 and
 * `@assistant-ui/react` 0.15.19 -- no version was forced -- but its output conflicts with this
 * package on every other axis. It rewrites `primitives/button.tsx`, `dialog.tsx` and `tooltip.tsx`
 * (owned by Tasks 3/5, not this one) to import `cn` from an npm package literally named `cn` and
 * `Slot`/`Tooltip` from the consolidated `radix-ui` meta-package -- both exactly what Task 3's
 * report rejected, and the latter left installed *alongside* the individual `@radix-ui/react-*`
 * packages rather than replacing them, i.e. the "both" outcome Task 3 flagged as a trap. It also
 * adds `remark-gfm`, `tw-shimmer` and `zustand`, and 17 new component files (attachments, files,
 * images, reasoning steps, tool-call groups, branch picker, follow-up suggestions) for a richer,
 * multi-modal/tool-calling assistant this OpenAI-compatible text chat has no use for and this
 * `useExternalStoreRuntime` adapter does not back. Adopting it would mean rewriting three files two
 * other tasks own and absorbing a much larger dependency/surface footprint to get a Thread that
 * still could not satisfy this file's controller-free, standalone-renderable interface without
 * further surgery. Kept the hand-rolled version; see the task report for the full diff.
 */

import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { Loader2Icon, SendHorizontalIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import type { ChatState } from "../core/chat-controller.js";
import type { ChatMessage } from "../core/sessions.js";
import { Button } from "./primitives/button.js";
import { indexOfId, isRunningFor, textOf, toThreadMessage } from "./thread-adapter.js";

const actionClass = "rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100";

function MarkdownText() {
  return <MarkdownTextPrimitive className="markdown" />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col items-end gap-1" data-role="user">
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-blue-50 px-4 py-2">
        <MessagePrimitive.Parts />
      </div>
      {/* Renders nothing when `Thread` wasn't given `onEdit` -- assistant-ui disables the
          button (and this reverts to a no-op) when the runtime has no edit capability. */}
      <ActionBarPrimitive.Root hideWhenRunning className="flex gap-1">
        <ActionBarPrimitive.Edit className={actionClass}>Edit</ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col items-start gap-1" data-role="assistant">
      <div className="max-w-[90%] px-1 py-2">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <ActionBarPrimitive.Root hideWhenRunning className="flex gap-1">
        <ActionBarPrimitive.Copy className={actionClass}>Copy</ActionBarPrimitive.Copy>
        {/* Renders nothing without `onRegenerate`/`onRegenerateFrom` -- same no-capability rule. */}
        <ActionBarPrimitive.Reload className={actionClass}>Regenerate</ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="flex flex-col gap-2 rounded-2xl border border-gray-300 p-2">
      <ComposerPrimitive.Input
        className="resize-none px-2 py-1 outline-none"
        aria-label="Edit message"
      />
      <div className="flex justify-end gap-2">
        <ComposerPrimitive.Cancel className={actionClass}>Cancel</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className={actionClass}>Save</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

function WaitingIndicator({ elapsedSeconds }: { elapsedSeconds: number }) {
  return (
    <div
      data-testid="waiting-indicator"
      aria-live="polite"
      className="flex max-w-[90%] items-center gap-2 rounded-2xl bg-gray-50 px-4 py-2 text-sm text-gray-500"
    >
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      <span>Waiting for a reply… {elapsedSeconds}s</span>
    </div>
  );
}

export interface ThreadProps {
  state: ChatState;
  /** `Date.now()`-shaped; a prop so the elapsed counter is testable without fake timers. */
  now: number;
  onCancel: () => void;
  onSend: (text: string) => void;
  /** Feature parity with the old controller-driven Thread; all optional, all absent in tests. */
  onEdit?: (index: number, text: string) => void;
  onRegenerate?: () => void;
  onRegenerateFrom?: (index: number) => void;
  onDismissError?: () => void;
}

export function Thread({
  state,
  now,
  onCancel,
  onSend,
  onEdit,
  onRegenerate,
  onRegenerateFrom,
  onDismissError,
}: ThreadProps) {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: state.session?.messages ?? [],
    isRunning: isRunningFor(state.phase),
    convertMessage: toThreadMessage,
    onNew: async (message) => onSend(textOf(message)),
    onEdit:
      onEdit == null
        ? undefined
        : async (message) => {
            const index = indexOfId(message.sourceId);
            if (index == null) onSend(textOf(message));
            else onEdit(index, textOf(message));
          },
    onReload:
      onRegenerate == null && onRegenerateFrom == null
        ? undefined
        : async (parentId) => {
            const index = indexOfId(parentId);
            if (index != null && onRegenerateFrom != null) onRegenerateFrom(index);
            else onRegenerate?.();
          },
    onCancel: async () => onCancel(),
  });

  const elapsedSeconds =
    state.runStartedAt == null ? 0 : Math.max(0, Math.floor((now - state.runStartedAt) / 1000));

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
          <ThreadPrimitive.Empty>
            <p className="m-auto text-gray-500">Send a message to start.</p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, EditComposer }} />
          {state.phase === "waiting" && <WaitingIndicator elapsedSeconds={elapsedSeconds} />}
        </ThreadPrimitive.Viewport>
        {state.error != null && (
          <div
            role="alert"
            className="mx-4 mb-2 flex items-start gap-3 rounded bg-red-50 p-3 text-sm text-red-800"
          >
            <div className="flex-1">
              <p>{state.error.message}</p>
              {state.error.hint != null && <p className="mt-1 font-medium">{state.error.hint}</p>}
            </div>
            {onDismissError != null && (
              <button type="button" className={actionClass} onClick={onDismissError}>
                Dismiss
              </button>
            )}
          </div>
        )}
        {state.isRunning && (
          <div className="flex justify-end px-4 pb-4">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              <SquareIcon />
              Stop
            </Button>
          </div>
        )}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export interface ComposerProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

/** `Thread`'s composer, extracted so `ChatApp` can hand it to `AppShell`'s `composer` slot. */
export function Composer({ disabled, onSend }: ComposerProps) {
  const [value, setValue] = useState("");

  const send = () => {
    const content = value.trim();
    if (content === "" || disabled) return;
    onSend(content);
    setValue("");
  };

  return (
    <div className="m-4 mt-0 flex items-end gap-2 rounded-2xl border border-gray-300 p-2">
      <textarea
        className="max-h-40 flex-1 resize-none px-2 py-1 outline-none disabled:opacity-50"
        placeholder="Message"
        aria-label="Message"
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <Button
        type="button"
        size="icon"
        disabled={disabled || value.trim() === ""}
        aria-label="Send"
        onClick={send}
      >
        <SendHorizontalIcon />
      </Button>
    </div>
  );
}
