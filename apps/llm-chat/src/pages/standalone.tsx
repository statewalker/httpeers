/** `index.html`: a placeholder until the chat UI lands (Task 7). */

import { createRoot } from "react-dom/client";
import "../ui/styles.css";

const root = document.getElementById("root");
if (root == null) throw new Error("index.html has no #root element");

createRoot(root).render(<p className="p-4">LLM chat</p>);
