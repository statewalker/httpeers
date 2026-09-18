/**
 * Between our OpenAI-shaped messages and assistant-ui's.
 *
 * A message's id is its index, so an edit's `sourceId` names the index the controller must replace.
 * Ids are regenerated from the array on every render; nothing stores them.
 */

import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage } from "../core/sessions.js";

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
