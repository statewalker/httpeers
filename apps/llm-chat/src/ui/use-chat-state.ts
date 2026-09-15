import { useSyncExternalStore } from "react";
import type { ChatController, ChatState } from "../core/chat-controller.js";

export function useChatState(controller: ChatController): ChatState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
