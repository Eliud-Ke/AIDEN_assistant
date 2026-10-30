import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./ChatPill.css";

export interface ChatTurn {
  id: string;
  userPrompt?: string | null;
  assistantReply: string;
  isStreaming?: boolean;
}

interface ChatPillProps {
  isAwake: boolean;
  isDarkMode: boolean;
  isMaxHeight?: boolean;
  turns?: ChatTurn[];
  followupThinkingPrompt?: string | null;
  userPrompt?: string | null;
  onSendMessage?: (message: string, isFollowup?: boolean) => void;
  onToggleSleep?: () => void;
  responseMessage?: string | null;
  activeUiTag?: string | null;
  isStreaming?: boolean;
  onClearResponse?: () => void;
  contentRef?: React.Ref<HTMLDivElement>;
  activeAudioTurnId?: string | null;
  isAudioPlaying?: boolean;
  onToggleTts?: (turnId: string, text: string) => void;
  isVoiceActive?: boolean;
  onToggleVoice?: (active: boolean) => void;
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

const LINE_LENGTH_THRESHOLD = 75;

function splitIntoSpringLines(text: string): string[] {
  if (!text) return [];

  const rawParagraphs = text.split("\n");
  const result: string[] = [];

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // If paragraph is shorter than threshold, keep it intact as a single spring line
    if (trimmed.length < LINE_LENGTH_THRESHOLD) {
      result.push(trimmed);
      continue;
    }

    // For longer paragraphs exceeding threshold, split on sentence ends (. ! ? :) followed by space
    const sentenceRegex = /([.!?:]+[\s]+)(?=[A-Z0-9\p{Emoji}]|$)/gu;
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    const sentences: string[] = [];
    while ((match = sentenceRegex.exec(para)) !== null) {
      const end = match.index + match[1].length;
      const segment = para.slice(lastIdx, end).trim();
      if (segment && (segment.length >= 35 || sentences.length > 0)) {
        sentences.push(segment);
        lastIdx = end;
      }
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

function findNextLineBoundary(text: string, fromIndex: number, isStreamEnded: boolean): number {
  if (fromIndex >= text.length) {
    return text.length;
  }

  if (isStreamEnded) {
    return text.length;
  }

  // Skip leading newlines right at fromIndex
  let start = fromIndex;
  while (start < text.length && (text[start] === "\n" || text[start] === "\r")) {
    start++;
  }

  if (start >= text.length) {
    return fromIndex;
  }

  const unrevealed = text.slice(start);

  // Media gallery boundary: don't split inside ::media-gallery[...]::
  const galleryIdx = unrevealed.indexOf("::media-");
  if (galleryIdx !== -1) {
    if (galleryIdx > 0) {
      return start + galleryIdx;
    }
    const galleryEnd = unrevealed.indexOf("::", 8);
    if (galleryEnd !== -1) {
      return start + galleryEnd + 2;
    }
    return fromIndex;
  }

  // 1. Check for explicit newline (\n)
  const newlineIdx = unrevealed.indexOf("\n");
  if (newlineIdx !== -1) {
    let end = start + newlineIdx + 1;
    // Consume consecutive newlines (\n\n or \r\n) so the next line starts with content
    while (end < text.length && (text[end] === "\n" || text[end] === "\r")) {
      end++;
    }
    return end;
  }

  // 2. Length threshold for paragraphs without newlines
  if (unrevealed.length >= LINE_LENGTH_THRESHOLD) {
    const sentenceRegex = /([.!?:]+[\s]+)(?=[A-Z0-9\p{Emoji}])/gu;
    let match: RegExpExecArray | null;
    let bestCut = -1;

    while ((match = sentenceRegex.exec(unrevealed)) !== null) {
      const cutPos = match.index + match[1].length;
      if (cutPos >= 35) {
        bestCut = cutPos;
        break;
      }
    }

    if (bestCut !== -1) {
      return start + bestCut;
    }

    // If paragraph is very long (>= 110 chars) without punctuation, break cleanly on a word boundary
    if (unrevealed.length >= 110) {
      const lastSpace = unrevealed.lastIndexOf(" ", 100);
      if (lastSpace >= 45) {
        return start + lastSpace + 1;
      }
    }
  }

  return fromIndex;
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

export const AppleConstellationSpinner: React.FC = () => (
  <span className="siri-apple-constellation" aria-hidden="true">
    <svg className="constellation-svg" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle className="c-dot c-dot-1" cx="12" cy="3.5" r="1.6" fill="currentColor" />
      <circle className="c-dot c-dot-2" cx="18" cy="6" r="1.6" fill="currentColor" />
      <circle className="c-dot c-dot-3" cx="20.5" cy="12" r="1.6" fill="currentColor" />
      <circle className="c-dot c-dot-4" cx="18" cy="18" r="1.6" fill="currentColor" />
      <circle className="c-dot c-dot-5" cx="12" cy="20.5" r="1.6" fill="currentColor" />
      <circle className="c-dot c-dot-6" cx="6" cy="18" r="1.6" fill="currentColor" />
      <circle className="c-dot c-dot-7" cx="3.5" cy="12" r="1.6" fill="currentColor" />
      <circle className="c-dot c-dot-8" cx="6" cy="6" r="1.6" fill="currentColor" />
    </svg>
  </span>
);

export const ChatPill: React.FC<ChatPillProps> = ({
  isAwake,
  isDarkMode,
  isMaxHeight = false,
  turns,
  followupThinkingPrompt = null,
  userPrompt = null,
  onSendMessage,
  onToggleSleep,
  responseMessage = null,
  activeUiTag = null,
  isStreaming = false,
  onClearResponse,
  contentRef,
  activeAudioTurnId = null,
  isAudioPlaying = false,
  onToggleTts,
  isVoiceActive,
  onToggleVoice,
}) => {
  const [inputText, setInputText] = useState("");
  const [selectedLightboxImage, setSelectedLightboxImage] = useState<MediaGalleryItem | null>(null);
  const [localVoiceActive, setLocalVoiceActive] = useState(false);
  const voiceActive = isVoiceActive !== undefined ? isVoiceActive : localVoiceActive;

  const toggleVoiceMode = (active: boolean) => {
    setLocalVoiceActive(active);
    if (onToggleVoice) onToggleVoice(active);
  };

  // Dynamic Shining Cursor tracking
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [cursorLeft, setCursorLeft] = useState(0);

  const [isMultiline, setIsMultiline] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const followupInputRef = useRef<HTMLInputElement>(null);
  const pillInputRef = useRef<HTMLTextAreaElement>(null);
  const cardInputRef = useRef<HTMLTextAreaElement>(null);
  const pillMeasureRef = useRef<HTMLSpanElement>(null);
  const cardMeasureRef = useRef<HTMLSpanElement>(null);
  const streamContainerRef = useRef<HTMLDivElement>(null);

  const activeTurns: ChatTurn[] = turns && turns.length > 0
    ? turns
    : responseMessage
    ? [{ id: "single-turn", userPrompt: null, assistantReply: responseMessage, isStreaming }]
    : [];

  const hasTurns = activeTurns.length > 0;
  const hasReplyText = hasTurns || Boolean((responseMessage && responseMessage.length > 0) || isStreaming);
  const isThinking = Boolean(!hasReplyText && (activeUiTag || isSubmitting));

  const pillMode: "idle" | "listening" | "thinking" | "responding" = hasReplyText
    ? "responding"
    : isThinking
    ? "thinking"
    : voiceActive
    ? "listening"
    : "idle";

  const showReplyWindow = pillMode === "responding";

  // Controls (minimize button and command bar) are visible on hover, when input is focused/typed, or in-stream thinking
  const isControlsVisible = Boolean(
    isHovered || isInputFocused || inputText.trim().length > 0 || followupThinkingPrompt
  );

  const respondingMountedAtRef = useRef<number>(0);

  // Reset hover state when entering or leaving responding mode
  useEffect(() => {
    if (pillMode === "responding") {
      respondingMountedAtRef.current = Date.now();
      setIsHovered(false);
    } else {
      setIsHovered(false);
    }
  }, [pillMode]);

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
        } else if (voiceActive) {
          toggleVoiceMode(false);
        } else if (pillMode === "responding" && onClearResponse) {
          onClearResponse();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [selectedLightboxImage, voiceActive, pillMode, onClearResponse]);

  // Reset scroll to top when a new conversation prompt is submitted so the user reads from the beginning
  useEffect(() => {
    if (userPrompt && streamContainerRef.current) {
      streamContainerRef.current.scrollTop = 0;
    }
  }, [userPrompt]);

  // Option A: Single smooth scroll when a follow-up prompt is submitted.
  // Scrolls the container so the newly submitted turn lands near the top of the viewport,
  // sliding the previous turn upward. Token streaming NEVER touches or hijacks the scroll!
  const lastScrolledFollowupRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!followupThinkingPrompt || !streamContainerRef.current) {
      if (!followupThinkingPrompt) {
        lastScrolledFollowupRef.current = null;
      }
      return;
    }
    if (lastScrolledFollowupRef.current === followupThinkingPrompt) return;
    lastScrolledFollowupRef.current = followupThinkingPrompt;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = streamContainerRef.current;
        if (!container) return;
        const pendingEl = container.querySelector(".siri-turn-item.pending-turn") as HTMLElement | null;
        if (pendingEl) {
          // Land cleanly at the top of the new turn stage, sliding the past turn off the viewport
          const targetTop = pendingEl.offsetTop - 16;
          container.scrollTo({
            top: Math.max(0, targetTop),
            behavior: "smooth",
          });
        }
      });
    });
  }, [followupThinkingPrompt]);

  // Dynamic smooth edge fade mask for scrollable stream container (smooth edge transitions, zero clipping)
  useLayoutEffect(() => {
    const el = streamContainerRef.current;
    if (!el) return;

    const updateMask = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const maxScroll = scrollHeight - clientHeight;

      // Top fade: dissolves smoothly under the floating minimize button when scrolled
      const topFade = Math.min(32, Math.max(0, scrollTop));
      const topStop = topFade > 0 ? `transparent 0%, black ${topFade}px` : `black 0px`;

      // Bottom fade:
      // When controls are visible, dissolve text softly across the command bar zone (84px)
      // When unhovered, dissolve at bottom edge only if content overflows
      let bottomStop: string;
      if (isControlsVisible) {
        bottomStop = `black calc(100% - 84px), transparent calc(100% - 16px)`;
      } else if (maxScroll > 2) {
        const bottomFade = Math.min(24, Math.max(0, maxScroll - scrollTop));
        bottomStop = bottomFade > 0 ? `black calc(100% - ${bottomFade}px), transparent 100%` : `black 100%`;
      } else {
        bottomStop = `black 100%`;
      }

      if (topStop === "black 0px" && bottomStop === "black 100%") {
        if (el.dataset.currentMask !== "none") {
          el.dataset.currentMask = "none";
          el.style.maskImage = "none";
          el.style.webkitMaskImage = "none";
        }
        return;
      }

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
  }, [showReplyWindow, activeTurns, followupThinkingPrompt, responseMessage, userPrompt, isControlsVisible]);

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
    setIsHovered(false);
    if (onSendMessage) {
      onSendMessage(trimmed, showReplyWindow);
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
            isMaxHeight ? "max-height" : ""
          } ${
            isControlsVisible ? "controls-visible" : ""
          } ${
            isHovered || isInputFocused || inputText.trim().length > 0 ? "hover-active" : ""
          } ${isMultiline && pillMode === "idle" ? "multiline" : ""} ${
            isDarkMode ? "dark-mode" : "light-mode"
          }`}
          onMouseEnter={() => {
            if (Date.now() - respondingMountedAtRef.current >= 100) {
              setIsHovered(true);
            }
          }}
          onMouseMove={() => {
            if (Date.now() - respondingMountedAtRef.current >= 100) {
              if (!isHovered) setIsHovered(true);
            }
          }}
          onMouseLeave={() => setIsHovered(false)}
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

              {/* Minimalist Bare Mic Icon (No background circle, just clean icon) */}
              <button
                type="button"
                className="siri-idle-bare-mic-btn"
                title="Voice Input (Click or Hold Shift)"
                aria-label="Voice input"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleVoiceMode(true);
                }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
            </>
          )}

          {/* 1.5. VOICE / LISTENING STATE (Compact Plump Capsule) */}
          {pillMode === "listening" && (
            <div
              className="siri-listening-content"
              onClick={(e) => {
                e.stopPropagation();
                toggleVoiceMode(false);
              }}
              title="Click or press Esc to return to Search"
            />
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
              {/* Floating Circular Glass Minimize Button (Top-Right) */}
              {onClearResponse && (
                <button
                  type="button"
                  className="siri-floating-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsHovered(false);
                    onClearResponse();
                  }}
                  title="Minimize (Esc)"
                  aria-label="Minimize"
                  tabIndex={isControlsVisible ? 0 : -1}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 14V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
                    <rect x="8" y="8" width="13" height="12" rx="2.5" fill="rgba(255, 255, 255, 0.2)" />
                  </svg>
                </button>
              )}

              {activeUiTag && !followupThinkingPrompt && (
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
                {activeTurns.map((turn) => (
                  <div key={turn.id} className="siri-turn-item">
                    {/* Turn 2+ user prompt bubble (Turn 1 has userPrompt === null, so zero bubble!) */}
                    {turn.userPrompt && (
                      <div className="siri-user-followup-wrap">
                        <div className="siri-user-followup-bubble">{turn.userPrompt}</div>
                      </div>
                    )}

                    {/* Assistant Reply for this turn */}
                    {turn.assistantReply && (
                      <div className="siri-assistant-reply">
                        {!turn.isStreaming && onToggleTts && (
                          <div className="siri-reply-header-bar">
                            <button
                              type="button"
                              className={`siri-reply-speaker-btn ${
                                activeAudioTurnId === turn.id
                                  ? isAudioPlaying
                                    ? "is-active"
                                    : "is-loading"
                                  : ""
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleTts(turn.id, turn.assistantReply);
                              }}
                              title={
                                activeAudioTurnId === turn.id
                                  ? isAudioPlaying
                                    ? "Stop speaking"
                                    : "Loading audio..."
                                  : "Read aloud"
                              }
                              aria-label="Read aloud"
                            >
                              {activeAudioTurnId === turn.id && !isAudioPlaying ? (
                                <span className="siri-speaker-spinner" />
                              ) : (
                                <svg
                                  className="siri-speaker-icon"
                                  width="13"
                                  height="13"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" fillOpacity="0.25" />
                                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                                </svg>
                              )}
                            </button>
                          </div>
                        )}
                        {parseMessageWithGalleries(turn.assistantReply, Boolean(turn.isStreaming)).map((part, idx) => {
                          if (part.type === "text") {
                            const lines = splitIntoSpringLines(part.text);
                            return (
                              <div key={idx} className="siri-text-block">
                                {lines.map((line, lineIdx) => {
                                  return (
                                    <span
                                      key={`spring-line-${lineIdx}`}
                                      className="siri-spring-line"
                                      style={{
                                        animationDelay: turn.isStreaming ? "0ms" : `${lineIdx * 40}ms`,
                                      }}
                                    >
                                      {renderFormattedText(line)}
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
                ))}

                {/* In-Flight Follow-up Prompt Bubble + Constellation Spinner (Shown while Turn 2+ is thinking) */}
                {followupThinkingPrompt && (
                  <div className="siri-turn-item pending-turn">
                    <div className="siri-user-followup-wrap">
                      <div className="siri-user-followup-bubble animated-spawn">
                        {followupThinkingPrompt}
                      </div>
                    </div>
                    <div className="siri-instream-thinking">
                      <AppleConstellationSpinner />
                      <span className="siri-instream-thinking-text">{formatStatusTag(activeUiTag || "Thinking")}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Apple-style Bottom Frosted Dissolve Shroud */}
              <div
                className={`siri-bottom-dissolve-shroud ${isControlsVisible ? "controls-visible" : ""}`}
                aria-hidden="true"
              />

              {/* Apple-style Persistent Follow-up Command Bar */}
              <div
                className={`siri-hover-followup-bar ${isControlsVisible ? "controls-visible" : ""}`}
              >
                <div className="siri-apple-command-bar">
                  {/* Left: Circular Frosted Glass Plus Button */}
                  <button
                    type="button"
                    className="siri-command-glass-btn plus-btn"
                    title="Add attachment or action"
                    aria-label="Add"
                    tabIndex={isControlsVisible ? 0 : -1}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>

                  {/* Center: Frosted Capsule Input with "Ask Aiden" placeholder */}
                  <div className="siri-command-capsule">
                    <input
                      ref={followupInputRef}
                      type="text"
                      className="siri-command-input"
                      placeholder="Ask Aiden"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onFocus={() => setIsInputFocused(true)}
                      onBlur={() => setIsInputFocused(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSend();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          if (selectedLightboxImage) {
                            setSelectedLightboxImage(null);
                          } else if (onClearResponse) {
                            setIsHovered(false);
                            onClearResponse();
                          }
                        }
                      }}
                      spellCheck={false}
                    />
                  </div>

                  {/* Right: Circular Frosted Glass Mic Button */}
                  <button
                    type="button"
                    className="siri-command-glass-btn mic-btn"
                    title="Dictate with Siri"
                    aria-label="Voice input"
                    tabIndex={isControlsVisible ? 0 : -1}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                  </button>
                </div>
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
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [followupThinkingPrompt, setFollowupThinkingPrompt] = useState<string | null>(null);
  const [activeUiTag, setActiveUiTag] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isMaxHeight, setIsMaxHeight] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);

  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;
  const followupThinkingPromptRef = useRef<string | null>(null);
  const currentTurnIdRef = useRef<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const targetTextRef = useRef<string>("");
  const displayedLengthRef = useRef<number>(0);
  const streamEndedRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);
  const lastLineEmittedTimeRef = useRef<number>(0);

  const contentRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef<number>(0);
  const lastModeRef = useRef<string>("idle");
  const rafResizeRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  // In-RAM TTS Audio State & Playback Engine
  const [activeAudioTurnId, setActiveAudioTurnId] = useState<string | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const activeAudioTurnIdRef = useRef<string | null>(null);
  activeAudioTurnIdRef.current = activeAudioTurnId;
  const isAudioPlayingRef = useRef<boolean>(false);
  isAudioPlayingRef.current = isAudioPlaying;
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioCacheRef = useRef<Map<string, string>>(new Map());

  const stopAudio = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
      audioPlayerRef.current = null;
    }
    setIsAudioPlaying(false);
    setActiveAudioTurnId(null);
  };

  const playBase64Audio = (turnId: string, base64Data: string) => {
    try {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current = null;
      }
      const audioUrl = `data:audio/mp3;base64,${base64Data}`;
      const audio = new Audio(audioUrl);
      audioPlayerRef.current = audio;
      setActiveAudioTurnId(turnId);
      setIsAudioPlaying(true);

      audio.onended = () => {
        setIsAudioPlaying(false);
        setActiveAudioTurnId(null);
        audioPlayerRef.current = null;
      };

      audio.onerror = (e) => {
        console.error("Audio playback error:", e);
        setIsAudioPlaying(false);
        setActiveAudioTurnId(null);
        audioPlayerRef.current = null;
      };

      audio.play().catch((err) => {
        console.warn("Audio play prevented:", err);
        setIsAudioPlaying(false);
        setActiveAudioTurnId(null);
      });
    } catch (err) {
      console.error("Failed to play audio:", err);
      setIsAudioPlaying(false);
      setActiveAudioTurnId(null);
    }
  };

  const handleToggleTts = (turnId: string, text: string) => {
    // 1. If currently playing this exact turn, click stops it
    if (activeAudioTurnIdRef.current === turnId && isAudioPlayingRef.current) {
      stopAudio();
      return;
    }

    // 2. Stop any other audio before switching
    stopAudio();

    // 3. Play from RAM cache if already downloaded
    const cached = audioCacheRef.current.get(turnId);
    if (cached) {
      playBase64Audio(turnId, cached);
      return;
    }

    // 4. Request TTS synthesis from backend over WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setActiveAudioTurnId(turnId);
      setIsAudioPlaying(false); // Indicates loading state
      wsRef.current.send(
        JSON.stringify({
          type: "tts_request",
          turnId,
          text,
          voice: "nova",
        })
      );
    }
  };

  const stopStreamRaf = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  const startSmoothStreamLoop = (turnId: string) => {
    if (rafIdRef.current !== null) return;

    const tick = () => {
      const activeId = currentTurnIdRef.current || turnId;
      const target = targetTextRef.current;
      const currentLen = displayedLengthRef.current;
      const isEnded = streamEndedRef.current;

      const nextBoundary = findNextLineBoundary(target, currentLen, isEnded);

      const now = Date.now();
      const elapsedSinceLastLine = now - lastLineEmittedTimeRef.current;
      // Minimum pacing between line reveals to let the Apple spring bounce play (85ms)
      const MIN_LINE_INTERVAL = 85;

      if (nextBoundary > currentLen && (elapsedSinceLastLine >= MIN_LINE_INTERVAL || currentLen === 0)) {
        displayedLengthRef.current = nextBoundary;
        lastLineEmittedTimeRef.current = now;
        const sliced = target.slice(0, nextBoundary);
        setTurns((prev) =>
          prev.map((t) => (t.id === activeId ? { ...t, assistantReply: sliced, isStreaming: true } : t))
        );
      } else if (isEnded && currentLen >= target.length) {
        setTurns((prev) =>
          prev.map((t) => (t.id === activeId ? { ...t, assistantReply: target, isStreaming: false } : t))
        );
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
    stopAudio();
    setIsVoiceActive(false);
    currentTurnIdRef.current = null;
    followupThinkingPromptRef.current = null;
    setFollowupThinkingPrompt(null);
    turnsRef.current = [];
    setTurns([]);
    setActiveUiTag(null);
    setIsStreaming(false);
    setIsMaxHeight(false);
    lastHeightRef.current = 130;
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
    lastLineEmittedTimeRef.current = 0;
  };

  const hasReplyText = turns.length > 0 || Boolean(followupThinkingPrompt) || isStreaming;
  const isExpanded = Boolean(hasReplyText);
  const isThinking = Boolean(!hasReplyText && activeUiTag);
  const currentMode: "idle" | "listening" | "thinking" | "responding" = hasReplyText
    ? "responding"
    : isThinking
    ? "thinking"
    : isVoiceActive
    ? "listening"
    : "idle";

  // Manage sleep exit animation & native window hide timing
  useEffect(() => {
    if (isAwake) {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      resetReplyState();
      invoke("set_chat_pill_state", { isAwake: true }).catch(() => {});
    } else {
      // Immediately pass cursor events through so background clicks work while fading out
      invoke("set_chat_pill_state", { isAwake: false }).catch(() => {});

      // Immediately clear reply state so sleeping pill never retains old turns
      resetReplyState();

      // Wait 300ms for the smooth glide-up & fade-out animation to complete before hiding the native Win32 window
      hideTimerRef.current = window.setTimeout(() => {
        invoke("hide_chat_pill").catch(() => {});
        hideTimerRef.current = null;
      }, 300);
    }

    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [isAwake]);

  // Immediate mode synchronization for native Windows DWM backdrop clipping
  useEffect(() => {
    if (!isAwake) return;
    const initialH = currentMode === "listening" ? 150 : (isExpanded ? (isMaxHeight ? 690 : 290) : 130);
    invoke("set_chat_pill_size", { width: 640, height: initialH, pillMode: currentMode, pill_mode: currentMode }).catch(() => {});
  }, [currentMode, isAwake, isExpanded, isMaxHeight]);

  // True dynamic window resizing: measures exact DOM height + allocates shadow breathing room
  useEffect(() => {
    if (!isAwake) {
      return;
    }

    const el = contentRef.current;
    if (!el) return;

    const applyTargetHeight = (rawHeight: number) => {
      // 18px top padding + 52px bottom shadow breathing room = 70px total vertical clearance
      const measured = isMaxHeight ? 620 : (rawHeight > 0 ? rawHeight : (isExpanded ? 220 : 60));
      const targetHeight = Math.max(130, Math.ceil(measured + 70));
      const modeChanged = lastModeRef.current !== currentMode;
      lastModeRef.current = currentMode;
      if (Math.abs(targetHeight - lastHeightRef.current) >= 2 || modeChanged || currentMode === "thinking" || currentMode === "listening" || isMaxHeight) {
        lastHeightRef.current = targetHeight;
        invoke("set_chat_pill_size", { width: 640, height: targetHeight, pillMode: currentMode, pill_mode: currentMode }).catch(() => {});
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
  }, [isAwake, isExpanded, currentMode, isMaxHeight]);

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
            setTurns([{ id: "sync-turn", userPrompt: null, assistantReply: payload.reply }]);
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
    stopAudio();
              targetTextRef.current = "";
              displayedLengthRef.current = 0;
              streamEndedRef.current = false;
              lastLineEmittedTimeRef.current = 0;
              setIsStreaming(true);
              setActiveUiTag(null);

              const newTurnId = "turn-" + Date.now();
              currentTurnIdRef.current = newTurnId;
              const userPromptForTurn = followupThinkingPromptRef.current;
              followupThinkingPromptRef.current = null;
              setFollowupThinkingPrompt(null);

              const newTurn: ChatTurn = {
                id: newTurnId,
                userPrompt: userPromptForTurn, // null for Turn 1, user query string for Turn 2+
                assistantReply: "",
                isStreaming: true,
              };

              setTurns((prev) => (userPromptForTurn ? [...prev, newTurn] : [newTurn]));
              startSmoothStreamLoop(newTurnId);
            } else if (msgType === "stream_chunk") {
              setIsStreaming(true);
              setActiveUiTag(null);

              if (!currentTurnIdRef.current) {
                const newTurnId = "turn-" + Date.now();
                currentTurnIdRef.current = newTurnId;
                const userPromptForTurn = followupThinkingPromptRef.current;
                followupThinkingPromptRef.current = null;
                setFollowupThinkingPrompt(null);
                const newTurn: ChatTurn = {
                  id: newTurnId,
                  userPrompt: userPromptForTurn,
                  assistantReply: "",
                  isStreaming: true,
                };
                setTurns((prev) => (userPromptForTurn ? [...prev, newTurn] : [newTurn]));
              }

              if (typeof data.fullContent === "string") {
                targetTextRef.current = data.fullContent;
              } else if (typeof data.token === "string") {
                targetTextRef.current += data.token;
              }
              if (currentTurnIdRef.current) {
                startSmoothStreamLoop(currentTurnIdRef.current);
              }
            } else if (msgType === "stream_end") {
              setActiveUiTag(null);
              if (typeof data.fullContent === "string") {
                targetTextRef.current = data.fullContent;
              }
              streamEndedRef.current = true;
              if (currentTurnIdRef.current) {
                startSmoothStreamLoop(currentTurnIdRef.current);
              }
            } else if (msgType === "error") {
              stopStreamRaf();
    stopAudio();
              setIsStreaming(false);
              setActiveUiTag("Error");
              const errText = String(data.message || "An unexpected error occurred.");
              const userPromptForTurn = followupThinkingPromptRef.current;
              followupThinkingPromptRef.current = null;
              setFollowupThinkingPrompt(null);

              const errorTurnId = "error-" + Date.now();
              currentTurnIdRef.current = null;
              setTurns((prev) => [
                ...prev,
                {
                  id: errorTurnId,
                  userPrompt: userPromptForTurn,
                  assistantReply: errText,
                  isStreaming: false,
                },
              ]);
            } else if (msgType === "tts_response") {
              const turnId = String(data.turnId || "");
              const base64Audio = String(data.audioBase64 || "");
              if (turnId && base64Audio) {
                audioCacheRef.current.set(turnId, base64Audio);
                if (activeAudioTurnIdRef.current === turnId) {
                  playBase64Audio(turnId, base64Audio);
                }
              }
            } else if (msgType === "tts_error") {
              const turnId = String(data.turnId || "");
              console.error("TTS error for turn", turnId, data.error);
              if (activeAudioTurnIdRef.current === turnId) {
                setActiveAudioTurnId(null);
                setIsAudioPlaying(false);
              }
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
    stopAudio();
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

  const handleSendMessage = (msg: string, isFollowup?: boolean) => {
    stopStreamRaf();
    stopAudio();
    setIsVoiceActive(false);
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
    lastLineEmittedTimeRef.current = 0;
    setIsStreaming(false);

    if (!isFollowup) {
      // Turn 1 (Fresh query from idle pill): completely clean past turns, start compact
      turnsRef.current = [];
      setTurns([]);
      followupThinkingPromptRef.current = null;
      setFollowupThinkingPrompt(null);
      setActiveUiTag("THINKING");
      setIsMaxHeight(false);
    } else {
      // Turn 2+: Follow-up query -> expand window to max luxury height, spawn follow-up bubble + in-stream thinking loader!
      setIsMaxHeight(true);
      followupThinkingPromptRef.current = msg;
      setFollowupThinkingPrompt(msg);
      setActiveUiTag("Thinking");
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "command",
          text: msg,
        })
      );
    } else {
      setActiveUiTag("Offline");
      const offlineMsg = "Aiden's backend is not running. Boot up Aiden from the Control Panel first.";
      if (turnsRef.current.length === 0) {
        setTurns([{ id: "offline", userPrompt: null, assistantReply: offlineMsg, isStreaming: false }]);
      } else {
        setTurns((prev) => [
          ...prev,
          { id: "offline-" + Date.now(), userPrompt: msg, assistantReply: offlineMsg, isStreaming: false },
        ]);
        setFollowupThinkingPrompt(null);
        followupThinkingPromptRef.current = null;
      }
    }
  };

  return (
    <div className="chat-pill-desktop-window">
      <ChatPill
        contentRef={contentRef}
        isAwake={isAwake}
        isDarkMode={isDarkMode}
        isMaxHeight={isMaxHeight}
        turns={turns}
        followupThinkingPrompt={followupThinkingPrompt}
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
        activeAudioTurnId={activeAudioTurnId}
        isAudioPlaying={isAudioPlaying}
        onToggleTts={handleToggleTts}
        isVoiceActive={isVoiceActive}
        onToggleVoice={setIsVoiceActive}
      />
    </div>
  );
};
