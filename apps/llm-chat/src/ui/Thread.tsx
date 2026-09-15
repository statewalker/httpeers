/**
 * The conversation, rendered by assistant-ui over OUR controller.
 *
 * `useExternalStoreRuntime` makes the controller the source of truth: assistant-ui only renders
 * `messages` and turns clicks into the callbacks below.
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
import type { ChatController } from "../core/chat-controller.js";
import type { ChatMessage } from "../core/sessions.js";
import { buttonClass, primaryButtonClass } from "./Modal.js";
import { indexOfId, textOf, toThreadMessage } from "./thread-adapter.js";
import { useChatState } from "./use-chat-state.js";

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
        <ComposerPrimitive.Cancel className={buttonClass}>Cancel</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className={primaryButtonClass}>Save</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

export function Thread({ controller }: { controller: ChatController }) {
  const state = useChatState(controller);
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: state.session?.messages ?? [],
    isRunning: state.isRunning,
    convertMessage: toThreadMessage,
    onNew: (message) => controller.send(textOf(message)),
    onEdit: (message) => {
      const index = indexOfId(message.sourceId);
      return index == null
        ? controller.send(textOf(message))
        : controller.edit(index, textOf(message));
    },
    onReload: () => controller.regenerate(),
    onCancel: async () => controller.cancel(),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
          <ThreadPrimitive.Empty>
            <p className="m-auto text-gray-500">Send a message to start.</p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, EditComposer }} />
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
            <button type="button" className={actionClass} onClick={controller.dismissError}>
              Dismiss
            </button>
          </div>
        )}
        <ComposerPrimitive.Root className="m-4 mt-0 flex items-end gap-2 rounded-2xl border border-gray-300 p-2">
          <ComposerPrimitive.Input
            className="max-h-40 flex-1 resize-none px-2 py-1 outline-none"
            placeholder="Message"
            aria-label="Message"
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className={primaryButtonClass}>Send</ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className={buttonClass}>Stop</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
