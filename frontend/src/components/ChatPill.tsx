import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "./ChatPill.css";

interface ChatPillProps {
  isAwake: boolean;
  isDarkMode: boolean;
  onSendMessage?: (message: string) => void;
  onToggleSleep?: () => void;
  responseMessage?: string | null;
  activeUiTag?: string | null;
  isStreaming?: boolean;
  onClearResponse?: () => void;
}

export const ChatPill: React.FC<ChatPillProps> = ({
  isAwake,
  isDarkMode,
  onSendMessage,
  responseMessage = null,
  activeUiTag = null,
  isStreaming = false,
  onClearResponse,
}) => {
  const [inputText, setInputText] = useState("");
  const [isMicActive, setIsMicActive] = useState(false);
  const [isVisionActive, setIsVisionActive] = useState(false);
  const [replyBodyHeight, setReplyBodyHeight] = useState<number>(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const responseTextRef = useRef<HTMLDivElement>(null);
  const responseContentInnerRef = useRef<HTMLDivElement>(null);

  const adjustTextareaHeight = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "21px";
    const maxHeight = 147; // Max 7 lines (7 * 21px line-height)
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  };

  // Auto-focus input when woken up
  useEffect(() => {
    if (isAwake) {
      adjustTextareaHeight(textareaRef.current);
      window.setTimeout(() => {
        textareaRef.current?.focus();
      }, 250);
    }
  }, [isAwake]);

  // Dynamically resize textarea up to 7 lines as text changes
  useEffect(() => {
    adjustTextareaHeight(textareaRef.current);
  }, [inputText]);

  const hasReplyText = Boolean((responseMessage && responseMessage.length > 0) || isStreaming);

  // Measure inner text height and smoothly animate the reply container height
  useLayoutEffect(() => {
    if (!hasReplyText || !responseContentInnerRef.current) {
      setReplyBodyHeight(0);
      return;
    }

    const updateHeight = () => {
      if (!responseContentInnerRef.current) return;
      const measured = responseContentInnerRef.current.offsetHeight;
      const clamped = Math.min(Math.max(measured, 20), 220);
      setReplyBodyHeight(clamped);

      if (responseTextRef.current && measured > 220) {
        responseTextRef.current.scrollTop = responseTextRef.current.scrollHeight;
      }
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(responseContentInnerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [responseMessage, isStreaming, hasReplyText]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    if (onSendMessage) {
      onSendMessage(trimmed);
    }
    setInputText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "21px";
    }
  };

  const formatStatusTag = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const lower = trimmed.toLowerCase();
    const formatted = lower.charAt(0).toUpperCase() + lower.slice(1);
    return formatted
      .replace(/\byoutube\b/gi, "YouTube")
      .replace(/\bspotify\b/gi, "Spotify")
      .replace(/\bgps\b/gi, "GPS")
      .replace(/\bobsidian\b/gi, "Obsidian")
      .replace(/\bnotion\b/gi, "Notion");
  };

  const showReplyWindow = Boolean(activeUiTag || hasReplyText);

  return (
    <div className="chat-pill-anchor">
      <div className={`chat-pill-wrapper ${isAwake ? "awake" : ""}`}>
        {/* Response Bubble above the pill with thick concentric bezel frame */}
        {showReplyWindow && (
          <div className={`chat-pill-response-frame ${isDarkMode ? "dark-frame" : "light-frame"}`}>
            <div className={`chat-pill-response-shell ${isDarkMode ? "dark-shell" : "light-shell"}`}>
              <div className="chat-pill-response-header">
                {/* Animated Tiny Orb of Strings + Shimmering Status Tag */}
                {activeUiTag ? (
                  <div className="chat-pill-ui-tag" key={activeUiTag}>
                    <span className="chat-pill-string-orb" aria-hidden="true">
                      <svg
                        className="string-orb-svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <ellipse
                           className="orb-string orb-string-1"
                          cx="12"
                          cy="12"
                          rx="9.5"
                          ry="4.2"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                        <ellipse
                          className="orb-string orb-string-2"
                          cx="12"
                          cy="12"
                          rx="9.5"
                          ry="4.2"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                        <ellipse
                          className="orb-string orb-string-3"
                          cx="12"
                          cy="12"
                          rx="9.5"
                          ry="4.2"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                        <circle
                          className="orb-core"
                          cx="12"
                          cy="12"
                          r="2.1"
                          fill="currentColor"
                        />
                      </svg>
                    </span>
                    <span className="chat-pill-ui-tag-text">
                      {formatStatusTag(activeUiTag)}
                    </span>
                  </div>
                ) : (
                  <div />
                )}

                {onClearResponse && (
                  <button
                    type="button"
                    className="chat-pill-response-close"
                    onClick={onClearResponse}
                    title="Dismiss reply"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>

              <div
                className={`chat-pill-response-body-animator ${hasReplyText ? "open" : "collapsed"}`}
                style={{
                  height: hasReplyText ? `${replyBodyHeight}px` : "0px",
                }}
              >
                <div ref={responseTextRef} className="chat-pill-response-text">
                  <div ref={responseContentInnerRef} className="chat-pill-response-text-inner">
                    {responseMessage}
                    {isStreaming && <span className="chat-pill-streaming-cursor" />}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* The Main Copilot-Style Floating Pill with thick concentric bezel frame */}
        <div className={`chat-pill-frame ${isDarkMode ? "dark-frame" : "light-frame"}`}>
          <div className={`chat-pill-shell ${isDarkMode ? "dark-shell" : "light-shell"}`}>
            {/* Top Row: Input Field without ellipses */}
            <div className="chat-pill-input-row">
              <textarea
                ref={textareaRef}
                className="chat-pill-textarea"
                placeholder={isMicActive ? "Listening for speech" : "Ask Aiden anything"}
                value={inputText}
                rows={1}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
              />
            </div>

            {/* Bottom Toolbar Row: Action buttons */}
            <div className="chat-pill-toolbar">
              <div className="chat-pill-toolbar-spacer" />

              <div className="chat-pill-actions">
                {/* Vision / Screen Context Button */}
                <button
                  type="button"
                  className={`chat-pill-btn ${isVisionActive ? "active" : ""}`}
                  onClick={() => setIsVisionActive((prev) => !prev)}
                  title={isVisionActive ? "Screen context active" : "Scan screen context"}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="14" r="4" />
                    <circle cx="18" cy="14" r="4" />
                    <path d="M14 14a2 2 0 0 0-4 0" />
                    <path d="M2.5 13L5 7" />
                    <path d="M21.5 13L19 7" />
                  </svg>
                </button>

                {/* Microphone / Voice Input Button */}
                <button
                  type="button"
                  className={`chat-pill-btn ${isMicActive ? "mic-listening active" : ""}`}
                  onClick={() => setIsMicActive((prev) => !prev)}
                  title={isMicActive ? "Mute microphone" : "Speak to Aiden"}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                </button>

                {/* Send Button */}
                {inputText.trim().length > 0 && (
                  <button
                    type="button"
                    className="chat-pill-send-btn"
                    onClick={handleSend}
                    title="Send message (Enter)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ChatPillSyncPayload {
  isAwake?: boolean | null;
  isDarkMode?: boolean | null;
  reply?: string | null;
}

/**
 * Standalone Window Container for the Taskbar-Floating Copilot Chat Pill ("chat_pill" window)
 * Uses a 60fps requestAnimationFrame adaptive stream buffer so incoming network token bursts
 * render with liquid smoothness while the reply window glides open seamlessly.
 */
export const ChatPillWindow: React.FC = () => {
  const [isAwake, setIsAwake] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [replyMessage, setReplyMessage] = useState<string | null>(null);
  const [activeUiTag, setActiveUiTag] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const targetTextRef = useRef<string>("");
  const displayedLengthRef = useRef<number>(0);
  const streamEndedRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);

  const stopStreamRaf = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  const resetReplyState = () => {
    stopStreamRaf();
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
    setReplyMessage(null);
    setActiveUiTag(null);
    setIsStreaming(false);
  };

  const startSmoothStreamLoop = () => {
    if (rafIdRef.current !== null) return;

    const tick = () => {
      const target = targetTextRef.current;
      const currentLen = displayedLengthRef.current;
      const diff = target.length - currentLen;

      if (diff > 0) {
        // Adaptive step: glides 1-2 chars on small diffs, smoothly accelerates on large bursts
        const step = Math.max(1, Math.min(diff, Math.ceil(diff * 0.16)));
        let nextLen = currentLen + step;

        // Avoid splitting UTF-16 surrogate pairs (emojis) mid-character
        if (nextLen < target.length) {
          const code = target.charCodeAt(nextLen - 1);
          if (code >= 0xd800 && code <= 0xdbff) {
            nextLen += 1;
          }
        }

        displayedLengthRef.current = nextLen;
        setReplyMessage(target.slice(0, nextLen));
        rafIdRef.current = requestAnimationFrame(tick);
      } else if (streamEndedRef.current) {
        setIsStreaming(false);
        rafIdRef.current = null;
      } else {
        rafIdRef.current = requestAnimationFrame(tick);
      }
    };

    rafIdRef.current = requestAnimationFrame(tick);
  };

  // Listen for theme/state sync from the main Tauri Launcher window
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    invoke<string>("get_windows_accent_color")
      .then((hex) => {
        if (hex) {
          document.documentElement.style.setProperty("--windows-accent", hex);
        }
      })
      .catch(() => {});

    listen<ChatPillSyncPayload>("chat-pill-sync", (event) => {
      const payload = event.payload;
      if (typeof payload?.isAwake === "boolean") {
        setIsAwake(payload.isAwake);
        if (!payload.isAwake) {
          resetReplyState();
        }
      }
      if (typeof payload?.isDarkMode === "boolean") {
        setIsDarkMode(payload.isDarkMode);
      }
      if (payload?.reply !== undefined) {
        stopStreamRaf();
        targetTextRef.current = payload.reply || "";
        displayedLengthRef.current = (payload.reply || "").length;
        setReplyMessage(payload.reply);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
      stopStreamRaf();
    };
  }, []);

  // Persistent WebSocket connection to backend/main.py (ws://127.0.0.1:8765)
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: number | null = null;

    const connectWebSocket = () => {
      if (!isMounted) return;

      try {
        const ws = new WebSocket("ws://127.0.0.1:8765");
        wsRef.current = ws;

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const msgType = data.type;

            if (msgType === "state") {
              const nextAwake = Boolean(data.isAwake);
              setIsAwake(nextAwake);
              invoke("set_chat_pill_state", { isAwake: nextAwake }).catch(() => {});

              if (!nextAwake) {
                resetReplyState();
              }
            } else if (msgType === "ui_tag") {
              const tag = String(data.tag || "").trim();
              if (tag) {
                setActiveUiTag(tag);
              }
            } else if (msgType === "stream_start") {
              stopStreamRaf();
              targetTextRef.current = "";
              displayedLengthRef.current = 0;
              streamEndedRef.current = false;
              setIsStreaming(true);
              setActiveUiTag(null);
              setReplyMessage("");
              startSmoothStreamLoop();
            } else if (msgType === "stream_chunk") {
              setIsStreaming(true);
              setActiveUiTag(null);
              if (typeof data.fullContent === "string") {
                targetTextRef.current = data.fullContent;
              } else if (typeof data.token === "string") {
                targetTextRef.current += data.token;
              }
              startSmoothStreamLoop();
            } else if (msgType === "stream_end") {
              setActiveUiTag(null);
              if (typeof data.fullContent === "string") {
                targetTextRef.current = data.fullContent;
              }
              streamEndedRef.current = true;
              startSmoothStreamLoop();
            } else if (msgType === "error") {
              stopStreamRaf();
              setIsStreaming(false);
              setActiveUiTag("Error");
              const errText = String(data.message || "An unexpected error occurred.");
              targetTextRef.current = errText;
              displayedLengthRef.current = errText.length;
              setReplyMessage(errText);
            }
          } catch {
            // Ignore malformed JSON frames
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (isMounted) {
            reconnectTimer = window.setTimeout(connectWebSocket, 1200);
          }
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {
            // Ignore
          }
        };
      } catch {
        if (isMounted) {
          reconnectTimer = window.setTimeout(connectWebSocket, 1500);
        }
      }
    };

    connectWebSocket();

    return () => {
      isMounted = false;
      stopStreamRaf();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // Ignore
        }
      }
    };
  }, []);

  const handleSendMessage = (msg: string) => {
    stopStreamRaf();
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
    setReplyMessage(null);
    setActiveUiTag("THINKING");
    setIsStreaming(false);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "command",
          text: msg,
        })
      );
    } else {
      setActiveUiTag("Offline");
      setReplyMessage("Aiden's backend is not running. Boot up Aiden from the Control Panel first.");
    }
  };

  return (
    <div className="chat-pill-desktop-window">
      <ChatPill
        isAwake={isAwake}
        isDarkMode={isDarkMode}
        responseMessage={replyMessage}
        activeUiTag={activeUiTag}
        isStreaming={isStreaming}
        onClearResponse={resetReplyState}
        onToggleSleep={() => {
          const nextAwake = !isAwake;
          setIsAwake(nextAwake);
          invoke("set_chat_pill_state", { isAwake: nextAwake }).catch(() => {});
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: nextAwake ? "wake" : "sleep" }));
          }
        }}
        onSendMessage={handleSendMessage}
      />
    </div>
  );
};
