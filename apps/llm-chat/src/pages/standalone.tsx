/** `index.html`: the chat on its own, with any OpenAI-compatible endpoint. */

import { createRoot } from "react-dom/client";
import { idbConfigStore, idbSessionStore } from "../core/idb.js";
import { ChatApp } from "../ui/ChatApp.js";
import "../ui/styles.css";

const root = document.getElementById("root");
if (root == null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <ChatApp
    configStore={idbConfigStore("standalone")}
    sessionStore={idbSessionStore()}
    title="LLM chat"
  />,
);
