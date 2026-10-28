import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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

interface MediaGalleryItem {
  url: string;
  title: string;
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "gallery"; items: MediaGalleryItem[] }
  | { type: "loading_gallery" };

function renderFormattedText(rawText: string): React.ReactNode {
  if (!rawText) return null;

  // Clean strip any accidental Markdown heading hashes (#, ##, ###) and triple backticks
  const cleanedText = rawText
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
    .replace(/```[a-zA-Z0-9_-]*/g, "")
    .replace(/```/g, "");

  // Regex matches markdown links: [Title](https://...)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(cleanedText)) !== null) {
    if (match.index > lastIndex) {
      elements.push(cleanedText.slice(lastIndex, match.index));
    }
    const title = match[1];
    const url = match[2];
    elements.push(
      <a
        key={match.index}
        href={url}
        className="siri-markdown-link"
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            openUrl(url).catch(() => window.open(url, "_blank"));
          } catch {
            window.open(url, "_blank");
          }
        }}
        title={url}
      >
        {title}
        <svg
          className="siri-link-icon"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>
    );
    lastIndex = linkRegex.lastIndex;
  }

  if (lastIndex < cleanedText.length) {
    elements.push(cleanedText.slice(lastIndex));
  }

  return elements.length > 0 ? elements : cleanedText;
}

function splitIntoSpringLines(text: string): string[] {
  if (!text) return [];

  const rawParagraphs = text.split("\n");
  const result: string[] = [];

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Splits paragraphs into sentences/clauses on punctuation (. ! ?) followed by whitespace & capital/emoji
    const sentenceRegex = /([.!?]+[\s]+)(?=[A-Z0-9\p{Emoji}])/gu;
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    const sentences: string[] = [];
    while ((match = sentenceRegex.exec(para)) !== null) {
      const end = match.index + match[1].length;
      const segment = para.slice(lastIdx, end).trim();
      if (segment) {
        sentences.push(segment);
      }
      lastIdx = end;
    }
    const remainder = para.slice(lastIdx).trim();
    if (remainder) {
      sentences.push(remainder);
    }

    if (sentences.length > 0) {
      result.push(...sentences);
    } else {
      result.push(trimmed);
    }
  }

  return result.length > 0 ? result : [text];
}

function parseMessageWithGalleries(rawText: string, isStreaming: boolean): MessagePart[] {
  if (!rawText) return [];

  const galleryRegex = /::media-(?:gallery|strip)\[([\s\S]*?)\]::/gi;
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = galleryRegex.exec(rawText)) !== null) {
    const textBefore = rawText.slice(lastIndex, match.index);
    if (textBefore) {
      parts.push({ type: "text", text: textBefore });
    }

    const rawPayload = match[1].trim();
    const items: MediaGalleryItem[] = [];

    // Check if JSON format
    if (rawPayload.startsWith("[") || rawPayload.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawPayload);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (item && typeof item === "object") {
            const u = item.thumbnail || item.url;
            if (u) {
              items.push({
                url: String(u),
                title: String(item.title || item.caption || "").trim(),
              });
            }
          }
        }
      } catch {
        // Fallback to text parsing
      }
    }

    // Comma-separated: "url | caption, url | caption"
    if (items.length === 0) {
      const entries = rawPayload.split(/,(?=\s*https?:\/\/|\s*["'{])/g);
      for (const entry of entries) {
        const trimmed = entry.trim().replace(/^["']|["']$/g, "");
        if (!trimmed) continue;
        if (trimmed.includes("|")) {
          const [u, ...rest] = trimmed.split("|");
          items.push({
            url: u.trim(),
            title: rest.join("|").trim(),
          });
        } else {
          const tokens = trimmed.split(/\s+/);
          const u = tokens[0];
          const t = tokens.slice(1).join(" ");
          if (u.startsWith("http")) {
            items.push({ url: u, title: t });
          }
        }
      }
    }

    if (items.length > 0) {
      parts.push({ type: "gallery", items });
    }
    lastIndex = galleryRegex.lastIndex;
  }

  const remaining = rawText.slice(lastIndex);
  if (remaining) {
    const partialMatch = /::media-(?:gallery|strip)\[[\s\S]*$/i.exec(remaining);
    if (partialMatch && isStreaming) {
      const textBeforePartial = remaining.slice(0, partialMatch.index);
      if (textBeforePartial) {
        parts.push({ type: "text", text: textBeforePartial });
      }
      parts.push({ type: "loading_gallery" });
    } else {
      parts.push({ type: "text", text: remaining });
    }
  }

  return parts;
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
  const [selectedLightboxImage, setSelectedLightboxImage] = useState<MediaGalleryItem | null>(null);

  // Dynamic Shining Cursor tracking
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [cursorLeft, setCursorLeft] = useState(0);

  const [isMultiline, setIsMultiline] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pillInputRef = useRef<HTMLTextAreaElement>(null);
  const cardInputRef = useRef<HTMLTextAreaElement>(null);
  const pillMeasureRef = useRef<HTMLSpanElement>(null);
  const cardMeasureRef = useRef<HTMLSpanElement>(null);
  const streamContainerRef = useRef<HTMLDivElement>(null);

  const hasReplyText = Boolean((responseMessage && responseMessage.length > 0) || isStreaming);
  const isThinking = Boolean(!hasReplyText && (activeUiTag || isSubmitting));

  const pillMode: "idle" | "thinking" | "responding" = hasReplyText
    ? "responding"
    : isThinking
    ? "thinking"
    : "idle";

  const showReplyWindow = pillMode === "responding";

  const cursorPrefix = inputText.slice(0, selectionIndex);

  // Measure text width up to the caret position for the shining cursor
  useLayoutEffect(() => {
    const activeMeasureRef = showReplyWindow ? cardMeasureRef : pillMeasureRef;
    if (activeMeasureRef.current) {
      setCursorLeft(activeMeasureRef.current.offsetWidth);
    }
  }, [inputText, selectionIndex, showReplyWindow]);

  // Auto-focus input when in idle mode
  useEffect(() => {
    if (isAwake && pillMode === "idle") {
      const timer = window.setTimeout(() => {
        pillInputRef.current?.focus();
        setSelectionIndex(pillInputRef.current?.selectionStart ?? inputText.length);
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [isAwake, pillMode]);

  // Global Escape key listener to collapse response back to pill
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedLightboxImage) {
          setSelectedLightboxImage(null);
        } else if (pillMode === "responding" && onClearResponse) {
          onClearResponse();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [selectedLightboxImage, pillMode, onClearResponse]);

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

  const updateSelection = (el: HTMLTextAreaElement | null) => {
    if (el) {
      setSelectionIndex(el.selectionStart ?? el.value.length);
    }
  };

  const resetTextarea = () => {
    setIsMultiline(false);
    if (pillInputRef.current) {
      pillInputRef.current.style.height = "";
      pillInputRef.current.scrollTop = 0;
    }
    if (cardInputRef.current) {
      cardInputRef.current.style.height = "";
      cardInputRef.current.scrollTop = 0;
    }
  };

  const adjustTextareaHeight = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const val = el.value || "";
    if (!val.trim()) {
      resetTextarea();
      return;
    }

    el.style.height = "auto";
    const minH = showReplyWindow ? 21 : 24;
    // Exactly 3 lines maximum height before internal scrolling activates
    const maxH = showReplyWindow ? 64 : 70;
    const scrollH = el.scrollHeight;
    const isMulti = scrollH > (minH + 6) || val.includes("\n");
    setIsMultiline(isMulti);

    const targetH = Math.min(Math.max(scrollH, minH), maxH);
    el.style.height = `${targetH}px`;
  };

  // Reset input expansion and sizing whenever a turn starts, input clears, speech arrives, or awake state toggles
  useEffect(() => {
    if (!inputText || !inputText.trim()) {
      resetTextarea();
    } else {
      const activeEl = showReplyWindow ? cardInputRef.current : pillInputRef.current;
      if (activeEl) {
        adjustTextareaHeight(activeEl);
      }
    }
  }, [inputText, showReplyWindow, isAwake, userPrompt]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (selectedLightboxImage) {
        setSelectedLightboxImage(null);
      } else if (showReplyWindow && onClearResponse) {
        onClearResponse();
      } else if (onToggleSleep) {
        onToggleSleep();
      }
    }
  };

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed || isSubmitting) return;
    setIsSubmitting(true);
    if (onSendMessage) {
      onSendMessage(trimmed);
    }
    setInputText("");
    setSelectionIndex(0);
    setCursorLeft(0);
    resetTextarea();
    window.setTimeout(() => {
      setIsSubmitting(false);
    }, 450);
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
        <div
          className={`siri-unified-pill siri-glass mode-${pillMode} ${
            isMultiline && pillMode === "idle" ? "multiline" : ""
          } ${isDarkMode ? "dark-mode" : "light-mode"}`}
        >
          {/* 1. IDLE / INPUT STATE */}
          {pillMode === "idle" && (
            <>
              <div className="siri-pill-input-wrap">
                <div className="siri-input-track">
                  <span ref={pillMeasureRef} className="siri-measure-text" aria-hidden="true">
                    {cursorPrefix}
                  </span>
                  {!isMultiline && (
                    <span
                      className="siri-shining-cursor"
                      style={{ left: `${cursorLeft}px` }}
                      aria-hidden="true"
                    />
                  )}
                  <textarea
                    ref={pillInputRef}
                    rows={1}
                    className={`siri-pill-input ${isMultiline ? "multiline" : ""}`}
                    placeholder="Search or Ask"
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      updateSelection(e.target);
                      adjustTextareaHeight(e.target);
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
                {!isSubmitting && inputText.trim().length > 0 && (
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
            </>
          )}

          {/* 2. THINKING STATE (Pill shrinks by 1/3, glowing pulse, shows status tag) */}
          {pillMode === "thinking" && (
            <div className="siri-thinking-content">
              <span className="siri-string-orb thinking-orb" aria-hidden="true">
                <svg className="string-orb-svg" width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <ellipse className="orb-string orb-string-1" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                  <ellipse className="orb-string orb-string-2" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                  <ellipse className="orb-string orb-string-3" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                  <circle className="orb-core" cx="12" cy="12" r="2.1" fill="currentColor" />
                </svg>
              </span>
              <span className="siri-thinking-text">{formatStatusTag(activeUiTag || "Thinking")}</span>
            </div>
          )}

          {/* 3. RESPONDING STATE (Expands back to full length and vertically into glass window) */}
          {pillMode === "responding" && (
            <>
              {activeUiTag && (
                <div className="siri-responding-header">
                  <div className="siri-responding-header-left">
                    <div className="siri-card-status-tag" key={activeUiTag}>
                      <span className="siri-string-orb" aria-hidden="true">
                        <svg className="string-orb-svg" width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <ellipse className="orb-string orb-string-1" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                          <ellipse className="orb-string orb-string-2" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                          <ellipse className="orb-string orb-string-3" cx="12" cy="12" rx="9.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" />
                          <circle className="orb-core" cx="12" cy="12" r="2.1" fill="currentColor" />
                        </svg>
                      </span>
                      <span className="siri-status-text">{formatStatusTag(activeUiTag)}</span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={streamContainerRef} className="siri-unified-stream">
                {responseMessage && (
                  <div className="siri-assistant-reply">
                    {parseMessageWithGalleries(responseMessage, isStreaming).map((part, idx, arr) => {
                      const isLast = idx === arr.length - 1;
                      if (part.type === "text") {
                        const lines = splitIntoSpringLines(part.text);
                        return (
                          <div key={idx} className="siri-text-block">
                            {lines.map((line, lineIdx) => {
                              const isLastLine = lineIdx === lines.length - 1;
                              return (
                                <span
                                  key={lineIdx}
                                  className="siri-spring-line"
                                  style={{
                                    animationDelay: isStreaming ? "0ms" : `${lineIdx * 45}ms`,
                                  }}
                                >
                                  {renderFormattedText(line)}
                                  {isLastLine && isLast && isStreaming && (
                                    <span className="siri-streaming-cursor" />
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        );
                      }

                      if (part.type === "loading_gallery") {
                        return (
                          <div key={idx} className="siri-media-gallery loading">
                            <div className="siri-media-skeleton" />
                            <div className="siri-media-skeleton" />
                            <div className="siri-media-skeleton" />
                          </div>
                        );
                      }
                      return (
                        <div key={idx} className="siri-media-gallery">
                          {part.items.map((item, imgIdx) => (
                            <div
                              key={imgIdx}
                              className="siri-media-card"
                              onClick={() => setSelectedLightboxImage(item)}
                              title={item.title ? `${item.title} (Click to enlarge)` : "Click to enlarge"}
                            >
                              <img src={item.url} alt={item.title || "Image"} className="siri-media-img" />
                              {item.title && <span className="siri-media-caption">{item.title}</span>}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {selectedLightboxImage && (
                <div className="siri-lightbox-overlay" onClick={() => setSelectedLightboxImage(null)}>
                  <div className="siri-lightbox-content" onClick={(e) => e.stopPropagation()}>
                    <img
                      src={selectedLightboxImage.url}
                      alt={selectedLightboxImage.title || "Preview"}
                      className="siri-lightbox-img"
                    />
                    <div className="siri-lightbox-bar">
                      <span className="siri-lightbox-title">{selectedLightboxImage.title}</span>
                      <button
                        type="button"
                        className="siri-lightbox-close"
                        onClick={() => setSelectedLightboxImage(null)}
                        title="Close (Esc)"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
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
  const isExpanded = Boolean(hasReplyText);

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
