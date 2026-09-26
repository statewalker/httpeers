/**
 * Between our OpenAI-shaped messages and assistant-ui's.
 *
 * A message's id is its index, so an edit's `sourceId` names the index the controller must replace.
 * Ids are regenerated from the array on every render; nothing stores them.
 */

import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { RunPhase } from "../core/chat-controller.js";
import type { ChatMessage } from "../core/sessions.js";

/**
 * assistant-ui's `useExternalStoreRuntime` only knows a boolean `isRunning`; `phase` (Task 2) is
 * our own richer source of truth (`idle` / `waiting` / `streaming`). Deriving `isRunning` from
 * `phase` here -- rather than reading `ChatState.isRunning` directly -- keeps `phase` the one
 * thing `Thread` has to pass through: the runtime still gets the field it reads, but it is
 * computed, not duplicated.
 */
export function isRunningFor(phase: RunPhase): boolean {
  return phase !== "idle";
}

export function messageId(index: number): string {
  return `m${index}`;
}

export function indexOfId(id: string | null | undefined): number | null {
  const match = id == null ? null : /^m(\d+)$/.exec(id);
  return match == null ? null : Number(match[1]);
}

export function toThreadMessage(message: ChatMessage, index: number): ThreadMessageLike {
  return {
    id: messageId(index),
    role: message.role,
    content: [{ type: "text", text: message.content }],
  };
}

export function textOf(message: AppendMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
