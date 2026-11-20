import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ChatPillWindow } from "./components/ChatPill";
import { PipCommentBubbleWindow } from "./components/PipCommentBubble";
import { PipHeadphonesWindow } from "./components/PipHeadphones";

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

const isPipBubbleWindow = (() => {
  try {
    if (window.location.search.includes("window=pip_bubble")) {
      return true;
    }
    return getCurrentWindow().label === "pip_bubble";
  } catch {
    return window.location.search.includes("window=pip_bubble");
  }
})();

const isPipHeadphonesWindow = (() => {
  try {
    if (window.location.search.includes("window=pip_headphones")) {
      return true;
    }
    return getCurrentWindow().label === "pip_headphones";
  } catch {
    return window.location.search.includes("window=pip_headphones");
  }
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isPipHeadphonesWindow ? (
      <PipHeadphonesWindow />
    ) : isPipBubbleWindow ? (
      <PipCommentBubbleWindow />
    ) : isChatPillWindow ? (
      <ChatPillWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
