import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ChatPillWindow } from "./components/ChatPill";

const isChatPillWindow = (() => {
  try {
    if (window.location.search.includes("window=chat_pill")) {
      return true;
    }
    return getCurrentWindow().label === "chat_pill";
  } catch {
    return window.location.search.includes("window=chat_pill");
  }
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isChatPillWindow ? <ChatPillWindow /> : <App />}
  </React.StrictMode>,
);
