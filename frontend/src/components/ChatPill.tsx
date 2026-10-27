import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "./ChatPill.css";

interface ChatPillProps {
  isAwake: boolean;
  isDarkMode: boolean;
  userPrompt?: string | null;
  onSendMessage?: (message: string) => void;
  onToggleSleep?: () => void;
  responseMessage?: string | null;
  activeUiTag?: string | null;
  isStreaming?: boolean;
  onClearResponse?: () => void;
  contentRef?: React.Ref<HTMLDivElement>;
}

export const ChatPill: React.FC<ChatPillProps> = ({
  isAwake,
  isDarkMode,
  userPrompt = null,
  onSendMessage,
  onToggleSleep,
  responseMessage = null,
  activeUiTag = null,
  isStreaming = false,
  onClearResponse,
  contentRef,
}) => {
  const [inputText, setInputText] = useState("");
  const [isMicActive, setIsMicActive] = useState(false);
  const [isVisionActive, setIsVisionActive] = useState(false);

  // Dynamic Shining Cursor tracking
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [cursorLeft, setCursorLeft] = useState(0);

  const pillInputRef = useRef<HTMLInputElement>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);
  const pillMeasureRef = useRef<HTMLSpanElement>(null);
  const cardMeasureRef = useRef<HTMLSpanElement>(null);
  const streamContainerRef = useRef<HTMLDivElement>(null);

  const hasReplyText = Boolean((responseMessage && responseMessage.length > 0) || isStreaming);
  const showReplyWindow = Boolean(activeUiTag || hasReplyText || userPrompt);

  const cursorPrefix = inputText.slice(0, selectionIndex);

  // Measure text width up to the caret position for the shining cursor
  useLayoutEffect(() => {
    const activeMeasureRef = showReplyWindow ? cardMeasureRef : pillMeasureRef;
    if (activeMeasureRef.current) {
      setCursorLeft(activeMeasureRef.current.offsetWidth);
    }
  }, [inputText, selectionIndex, showReplyWindow]);

  // Auto-focus the active input when woken up or transitioning views
  useEffect(() => {
    if (isAwake) {
      const timer = window.setTimeout(() => {
        if (showReplyWindow) {
          cardInputRef.current?.focus();
          setSelectionIndex(cardInputRef.current?.selectionStart ?? inputText.length);
        } else {
          pillInputRef.current?.focus();
          setSelectionIndex(pillInputRef.current?.selectionStart ?? inputText.length);
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isAwake, showReplyWindow]);

  // Reset scroll to top when a new conversation prompt is submitted so the user reads from the beginning
  useEffect(() => {
    if (userPrompt && streamContainerRef.current) {
      streamContainerRef.current.scrollTop = 0;
    }
  }, [userPrompt]);

  // Dynamic smooth edge fade mask for scrollable stream container (smooth edge transitions, zero clipping)
  useLayoutEffect(() => {
    const el = streamContainerRef.current;
    if (!el) return;

    const updateMask = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const maxScroll = scrollHeight - clientHeight;

      // If content doesn't overflow, keep it completely crisp with no mask
      if (maxScroll <= 2) {
        if (el.dataset.currentMask !== "none") {
          el.dataset.currentMask = "none";
          el.style.maskImage = "none";
          el.style.webkitMaskImage = "none";
        }
        return;
      }

      // Smooth continuous fade depth based on scroll position (up to 28px)
      const topFade = Math.min(28, Math.max(0, scrollTop));
      const bottomFade = Math.min(28, Math.max(0, maxScroll - scrollTop));

      const topStop = topFade > 0 ? `transparent 0%, black ${topFade}px` : `black 0px`;
      const bottomStop = bottomFade > 0 ? `black calc(100% - ${bottomFade}px), transparent 100%` : `black 100%`;

      const mask = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;
      if (el.dataset.currentMask !== mask) {
        el.dataset.currentMask = mask;
        el.style.maskImage = mask;
        el.style.webkitMaskImage = mask;
      }
    };

    updateMask();

    const onScroll = () => {
      updateMask();
    };

    el.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      updateMask();
    });
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [showReplyWindow, responseMessage, userPrompt]);

  const updateSelection = (el: HTMLInputElement | null) => {
    if (el) {
      setSelectionIndex(el.selectionStart ?? el.value.length);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (showReplyWindow && onClearResponse) {
        onClearResponse();
      } else if (onToggleSleep) {
        onToggleSleep();
      }
    }
  };

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    if (onSendMessage) {
      onSendMessage(trimmed);
    }
    setInputText("");
    setSelectionIndex(0);
    setCursorLeft(0);
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

  return (
    <div className="chat-pill-anchor">
      <div ref={contentRef} className={`chat-pill-wrapper ${isAwake ? "awake" : ""}`}>
        {showReplyWindow ? (
          /* ==========================================================================
             EXPANDED STATE: SIRI CONVERSATION CARD (IMAGE 2)
             ========================================================================== */
          <div className={`siri-card siri-glass ${isDarkMode ? "dark-mode" : "light-mode"}`}>
            {/* Card Header Bar: Status/Orb on left, Minimize Button on right (no 'x' button) */}
            <div className="siri-card-header">
              {/* Shimmering Status Tag + Tiny String Orb */}
              {activeUiTag ? (
                <div className="siri-card-status-tag" key={activeUiTag}>
                  <span className="siri-string-orb" aria-hidden="true">
                    <svg className="string-orb-svg" width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <ellipse className="orb-string orb-string-1" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                      <ellipse className="orb-string orb-string-2" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                      <ellipse className="orb-string orb-string-3" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                      <circle className="orb-core" cx="12" cy="12" r="2.1" fill="currentColor" />
                    </svg>
                  </span>
                  <span className="siri-status-text">{formatStatusTag(activeUiTag)}</span>
                </div>
              ) : (
                <div className="siri-card-header-spacer" />
              )}

              {/* Minimize / Contract Button on top right (returns expanded UI back to Search or Ask) */}
              {onClearResponse && (
                <button
                  type="button"
                  className="siri-card-header-btn"
                  onClick={onClearResponse}
                  title="Minimize to Search or Ask (Esc)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </button>
              )}
            </div>

            {/* Conversation Stream: User Prompt Bubble on right + Assistant Answer on left */}
            <div ref={streamContainerRef} className="siri-card-stream">
              {userPrompt && (
                <div className="siri-user-prompt-pill">
                  {userPrompt}
                </div>
              )}

              {responseMessage && (
                <div className="siri-assistant-reply">
                  {responseMessage}
                  {isStreaming && <span className="siri-streaming-cursor" />}
                </div>
              )}

              {!responseMessage && isStreaming && (
                <div className="siri-assistant-reply">
                  <span className="siri-streaming-cursor" />
                </div>
              )}
            </div>

            {/* Bottom Input Capsule Bar from Image 2 */}
            <div className="siri-card-bottom-bar">
              <button
                type="button"
                className={`siri-card-action-btn ${isVisionActive ? "active" : ""}`}
                onClick={() => setIsVisionActive((prev) => !prev)}
                title={isVisionActive ? "Screen context active" : "Add screen context"}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>

              <div className="siri-card-input-capsule">
                <div className="siri-input-track">
                  {/* Invisible text measurer */}
                  <span ref={cardMeasureRef} className="siri-measure-text" aria-hidden="true">
                    {cursorPrefix}
                  </span>
                  {/* Real Shining Animated Cursor */}
                  <span
                    className="siri-shining-cursor"
                    style={{ left: `${cursorLeft}px` }}
                    aria-hidden="true"
                  />
                  <input
                    ref={cardInputRef}
                    type="text"
                    className="siri-card-input"
                    placeholder={isMicActive ? "Listening..." : "Ask Aiden"}
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      updateSelection(e.target);
                    }}
                    onSelect={(e) => updateSelection(e.currentTarget)}
                    onKeyUp={(e) => updateSelection(e.currentTarget)}
                    onClick={(e) => updateSelection(e.currentTarget)}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                  />
                </div>
              </div>

              <button
                type="button"
                className={`siri-card-action-btn ${isMicActive ? "mic-listening active" : ""}`}
                onClick={() => setIsMicActive((prev) => !prev)}
                title={isMicActive ? "Mute microphone" : "Speak to Aiden"}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              </button>

              {inputText.trim().length > 0 && (
                <button
                  type="button"
                  className="siri-send-btn"
                  onClick={handleSend}
                  title="Send message (Enter)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ==========================================================================
             IDLE / INPUT STATE: SLEEK SIRI CAPSULE PILL (IMAGE 1)
             ========================================================================== */
          <div className={`siri-pill-capsule siri-glass ${isDarkMode ? "dark-mode" : "light-mode"}`}>
            <div className="siri-pill-input-wrap">
              <div className="siri-input-track">
                {/* Invisible text measurer */}
                <span ref={pillMeasureRef} className="siri-measure-text" aria-hidden="true">
                  {cursorPrefix}
                </span>
                {/* Real Shining Animated Cursor */}
                <span
                  className="siri-shining-cursor"
                  style={{ left: `${cursorLeft}px` }}
                  aria-hidden="true"
                />
                <input
                  ref={pillInputRef}
                  type="text"
                  className="siri-pill-input"
                  placeholder={isMicActive ? "Listening for speech..." : "Search or Ask"}
                  value={inputText}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    updateSelection(e.target);
                  }}
                  onSelect={(e) => updateSelection(e.currentTarget)}
                  onKeyUp={(e) => updateSelection(e.currentTarget)}
                  onClick={(e) => updateSelection(e.currentTarget)}
                  onKeyDown={handleKeyDown}
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="siri-pill-actions">
              {/* Vision Context Button */}
              <button
                type="button"
                className={`siri-pill-btn ${isVisionActive ? "active" : ""}`}
                onClick={() => setIsVisionActive((prev) => !prev)}
                title={isVisionActive ? "Screen context active" : "Scan screen context"}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="14" r="4" />
                  <circle cx="18" cy="14" r="4" />
                  <path d="M14 14a2 2 0 0 0-4 0" />
                  <path d="M2.5 13L5 7" />
                  <path d="M21.5 13L19 7" />
                </svg>
              </button>

              {/* Apple-Style Microphone Button */}
              <button
                type="button"
                className={`siri-pill-btn ${isMicActive ? "mic-listening active" : ""}`}
                onClick={() => setIsMicActive((prev) => !prev)}
                title={isMicActive ? "Mute microphone" : "Speak to Aiden"}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              </button>

              {/* Send Button */}
              {inputText.trim().length > 0 && (
                <button
                  type="button"
                  className="siri-send-btn"
                  onClick={handleSend}
                  title="Send message (Enter)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface ChatPillSyncPayload {
  isAwake?: boolean | null;
  isDarkMode?: boolean | null;
  reply?: string | null;
  expanded?: boolean | null;
}

/**
 * Standalone Window Container for the Siri-Style AI Pill ("chat_pill" window)
 */
export const ChatPillWindow: React.FC = () => {
  const [isAwake, setIsAwake] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [replyMessage, setReplyMessage] = useState<string | null>(null);
  const [lastUserPrompt, setLastUserPrompt] = useState<string | null>(null);
  const [activeUiTag, setActiveUiTag] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const targetTextRef = useRef<string>("");
  const displayedLengthRef = useRef<number>(0);
  const streamEndedRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef<number>(0);
  const rafResizeRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const stopStreamRaf = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  const startSmoothStreamLoop = () => {
    if (rafIdRef.current !== null) return;

    const tick = () => {
      const target = targetTextRef.current;
      const currentLen = displayedLengthRef.current;

      if (currentLen < target.length) {
        const remaining = target.length - currentLen;
        const step = Math.max(1, Math.min(Math.ceil(remaining / 3), 6));
        const nextLen = Math.min(currentLen + step, target.length);
        displayedLengthRef.current = nextLen;
        setReplyMessage(target.slice(0, nextLen));
      } else if (streamEndedRef.current) {
        setReplyMessage(target);
        setIsStreaming(false);
        stopStreamRaf();
        return;
      }

      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
  };

  const resetReplyState = () => {
    stopStreamRaf();
    setLastUserPrompt(null);
    setReplyMessage(null);
    setActiveUiTag(null);
    setIsStreaming(false);
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
  };

  const hasReplyText = Boolean((replyMessage && replyMessage.length > 0) || isStreaming);
  const isExpanded = Boolean(activeUiTag || hasReplyText || lastUserPrompt);

  // Manage sleep exit animation & native window hide timing
  useEffect(() => {
    if (isAwake) {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      invoke("set_chat_pill_state", { isAwake: true }).catch(() => {});
    } else {
      // Immediately pass cursor events through so background clicks work while fading out
      invoke("set_chat_pill_state", { isAwake: false }).catch(() => {});

      // Wait 300ms for the smooth glide-up & fade-out animation to complete before hiding the native Win32 window
      hideTimerRef.current = window.setTimeout(() => {
        invoke("hide_chat_pill").catch(() => {});
        resetReplyState();
        lastHeightRef.current = 130;
        hideTimerRef.current = null;
      }, 300);
    }

    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [isAwake]);

  // True dynamic window resizing: measures exact DOM height + allocates shadow breathing room
  useEffect(() => {
    if (!isAwake) {
      return;
    }

    const el = contentRef.current;
    if (!el) return;

    const applyTargetHeight = (rawHeight: number) => {
      // 18px top padding + 52px bottom shadow breathing room = 70px total vertical clearance
      const measured = rawHeight > 0 ? rawHeight : (isExpanded ? 220 : 60);
      const targetHeight = Math.max(130, Math.ceil(measured + 70));
      if (Math.abs(targetHeight - lastHeightRef.current) >= 2) {
        lastHeightRef.current = targetHeight;
        invoke("set_chat_pill_size", { width: 640, height: targetHeight }).catch(() => {});
      }
    };

    // Initial measurement
    applyTargetHeight(el.offsetHeight);

    const observer = new ResizeObserver((entries) => {
      if (rafResizeRef.current !== null) {
        cancelAnimationFrame(rafResizeRef.current);
      }
      rafResizeRef.current = requestAnimationFrame(() => {
        for (const entry of entries) {
          const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          applyTargetHeight(h);
        }
      });
    });

    observer.observe(el);

    return () => {
      observer.disconnect();
      if (rafResizeRef.current !== null) {
        cancelAnimationFrame(rafResizeRef.current);
      }
    };
  }, [isAwake, isExpanded]);

  // Sync state events from Tauri main process
  useEffect(() => {
    let unlistenSync: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlistenSync = await listen<ChatPillSyncPayload>("chat-pill-sync", (event) => {
          const payload = event.payload;
          if (typeof payload.isAwake === "boolean") {
            setIsAwake(payload.isAwake);
          }
          if (typeof payload.isDarkMode === "boolean") {
            setIsDarkMode(payload.isDarkMode);
          }
          if (typeof payload.reply === "string") {
            setReplyMessage(payload.reply);
          }
        });
      } catch {
        // Fallback if running outside Tauri
      }
    };

    setupListener();

    return () => {
      if (unlistenSync) unlistenSync();
    };
  }, []);

  // Real-time backend WebSocket connection
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: number | null = null;

    const connectWebSocket = () => {
      try {
        const ws = new WebSocket("ws://127.0.0.1:8765");
        wsRef.current = ws;

        ws.onopen = () => {
          // Connected
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const msgType = data.type;

            if (msgType === "state" || msgType === "state_change") {
              const nextAwake = Boolean(data.isAwake);
              setIsAwake(nextAwake);
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
            // Ignore malformed frames
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
    setLastUserPrompt(msg);
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
        contentRef={contentRef}
        isAwake={isAwake}
        isDarkMode={isDarkMode}
        userPrompt={lastUserPrompt}
        responseMessage={replyMessage}
        activeUiTag={activeUiTag}
        isStreaming={isStreaming}
        onClearResponse={resetReplyState}
        onToggleSleep={() => {
          const nextAwake = !isAwake;
          setIsAwake(nextAwake);
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: nextAwake ? "wake" : "sleep" }));
          }
        }}
        onSendMessage={handleSendMessage}
      />
    </div>
  );
};
