import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LocationCard } from "./LocationCard";
import { GmailCard, GmailEmailItem } from "./GmailCard";
import { CalendarCard, CalendarEventItem } from "./CalendarCard";
import { SystemSlider } from "./SystemSlider";
import { WeatherCard, WeatherCardData } from "./WeatherCard";
import "./ChatPill.css";

export interface ChatTurn {
  id: string;
  userPrompt?: string | null;
  assistantReply: string;
  isStreaming?: boolean;
  connectors?: string[];
}

export interface ConnectorMeta {
  key: string;
  name: string;
  icon: string;
}

export const CONNECTOR_METAS: Record<string, { name: string; icon: string }> = {
  gmail: { name: "Gmail", icon: "/icons/mail.png" },
  mail: { name: "Gmail", icon: "/icons/mail.png" },
  email: { name: "Gmail", icon: "/icons/mail.png" },
  spotify: { name: "Spotify", icon: "/icons/spotify.png" },
  google_calendar: { name: "Google Calendar", icon: "/icons/calendar.png" },
  calendar: { name: "Google Calendar", icon: "/icons/calendar.png" },
  notes_vault: { name: "Notes Vault", icon: "/icons/obsidian.png" },
  notes: { name: "Notes Vault", icon: "/icons/obsidian.png" },
  youtube_visual: { name: "YouTube", icon: "/icons/youtube.png" },
  youtube: { name: "YouTube", icon: "/icons/youtube.png" },
  file_system: { name: "Files", icon: "/icons/explorer.png" },
  files: { name: "Files", icon: "/icons/explorer.png" },
};

export const resolveConnectorMeta = (
  tagOrKey?: string | null,
  explicitConnector?: string | null
): ConnectorMeta | null => {
  if (explicitConnector) {
    const cleanExp = explicitConnector.toLowerCase().trim();
    if (CONNECTOR_METAS[cleanExp]) {
      return { key: cleanExp, ...CONNECTOR_METAS[cleanExp] };
    }
  }
  if (!tagOrKey) return null;
  const lower = tagOrKey.toLowerCase();
  if (
    lower.includes("gmail") ||
    lower.includes("email") ||
    lower.includes("unread") ||
    lower.includes("inbox") ||
    lower.includes("draft")
  ) {
    return { key: "gmail", ...CONNECTOR_METAS.gmail };
  }
  if (lower.includes("spotify") || lower.includes("music")) {
    return { key: "spotify", ...CONNECTOR_METAS.spotify };
  }
  if (lower.includes("calendar")) {
    return { key: "google_calendar", ...CONNECTOR_METAS.google_calendar };
  }
  if (lower.includes("notes") || lower.includes("obsidian")) {
    return { key: "notes_vault", ...CONNECTOR_METAS.notes_vault };
  }
  if (lower.includes("youtube")) {
    return { key: "youtube_visual", ...CONNECTOR_METAS.youtube_visual };
  }
  if (lower.includes("file") || lower.includes("explorer")) {
    return { key: "file_system", ...CONNECTOR_METAS.file_system };
  }
  return null;
};

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
  activeConnector?: string | null;
  isStreaming?: boolean;
  onClearResponse?: () => void;
  contentRef?: React.Ref<HTMLDivElement>;
  activeAudioTurnId?: string | null;
  isAudioPlaying?: boolean;
  onToggleTts?: (turnId: string, text: string) => void;
  isVoiceActive?: boolean;
  onToggleVoice?: (active: boolean) => void;
  isExitingVoice?: boolean;
  isEnteringVoice?: boolean;
  audioMeter?: { level: number; bass: number; mid: number; high: number };
  isRecording?: boolean;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onHardwareChange?: (action: "volume" | "brightness", level?: number, muted?: boolean) => void;
}

interface MediaGalleryItem {
  url: string;
  title: string;
}

export interface LocationCardData {
  lat: number;
  lon: number;
  title?: string;
}

export interface GmailCardData {
  count?: number;
  emails?: GmailEmailItem[];
  subtitle?: string;
  mode?: "unread" | "search" | "read";
  query?: string;
  id?: string;
  sender?: string;
  email?: string;
  date?: string;
  subject?: string;
  summary?: string;
  avatar?: string;
}

export interface CalendarCardData {
  mode?: "agenda" | "created" | "search" | "updated" | "deleted" | "availability";
  label?: string;
  count?: number;
  events?: CalendarEventItem[];
  event?: CalendarEventItem;
  query?: string;
  oldTime?: string;
  newTime?: string;
  timeWindow?: string;
  isFree?: boolean;
  conflicts?: Array<{ summary: string; time: string; location?: string }>;
  suggestedSlot?: string;
}

export interface SystemSliderData {
  type: "volume" | "brightness";
  level: number;
  muted?: boolean;
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "gallery"; items: MediaGalleryItem[] }
  | { type: "loading_gallery" }
  | { type: "location"; data: LocationCardData }
  | { type: "loading_location" }
  | { type: "gmail"; data: GmailCardData }
  | { type: "calendar"; data: CalendarCardData }
  | { type: "system_slider"; data: SystemSliderData }
  | { type: "weather"; data: WeatherCardData };

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

  const rawParagraphs = text.split("\r\n");
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
  while (start < text.length && (text[start] === "\r\n" || text[start] === "\r")) {
    start++;
  }

  if (start >= text.length) {
    return fromIndex;
  }

  const unrevealed = text.slice(start);

  // Media gallery, Location card, Gmail card, or Calendar card boundary: don't split inside ::...[...]::
  const embedMatch = /::(?:media-|location-|gmail-|calendar-)/.exec(unrevealed);
  if (embedMatch) {
    const embedIdx = embedMatch.index;
    if (embedIdx > 0) {
      return start + embedIdx;
    }
    const embedEnd = unrevealed.indexOf("::", 8);
    if (embedEnd !== -1) {
      return start + embedEnd + 2;
    }
    return fromIndex;
  }

  // 1. Check for explicit newline (\r\n)
  const newlineIdx = unrevealed.indexOf("\r\n");
  if (newlineIdx !== -1) {
    let end = start + newlineIdx + 1;
    // Consume consecutive newlines (\r\n\r\n or \r\n) so the next line starts with content
    while (end < text.length && (text[end] === "\r\n" || text[end] === "\r")) {
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

  const embedRegex = /::(media-(?:gallery|strip)|location-card|gmail-card|calendar-card|system-slider|weather-card)\[([\s\S]*?)\]::/gi;
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = embedRegex.exec(rawText)) !== null) {
    const textBefore = rawText.slice(lastIndex, match.index);
    if (textBefore) {
      parts.push({ type: "text", text: textBefore });
    }

    const tagType = match[1].toLowerCase();
    const rawPayload = match[2].trim();

    if (tagType === "calendar-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const eventsList: CalendarEventItem[] = Array.isArray(parsed.events)
          ? parsed.events
          : Array.isArray(parsed)
          ? parsed
          : [];
        const count = typeof parsed.count === "number" ? parsed.count : eventsList.length;
        const label = typeof parsed.label === "string" ? parsed.label : undefined;
        const mode =
          parsed.mode === "created"
            ? "created"
            : parsed.mode === "search"
            ? "search"
            : parsed.mode === "updated"
            ? "updated"
            : parsed.mode === "deleted"
            ? "deleted"
            : parsed.mode === "availability"
            ? "availability"
            : "agenda";
        const query = typeof parsed.query === "string" ? parsed.query : undefined;
        const oldTime = typeof parsed.oldTime === "string" ? parsed.oldTime : undefined;
        const newTime = typeof parsed.newTime === "string" ? parsed.newTime : undefined;
        const timeWindow = typeof parsed.timeWindow === "string" ? parsed.timeWindow : undefined;
        const isFree = typeof parsed.isFree === "boolean" ? parsed.isFree : undefined;
        const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : undefined;
        const suggestedSlot = typeof parsed.suggestedSlot === "string" ? parsed.suggestedSlot : undefined;
        const singleEvent = parsed.event && typeof parsed.event === "object" ? parsed.event : undefined;

        parts.push({
          type: "calendar",
          data: {
            mode,
            label,
            count,
            events: eventsList,
            event: singleEvent,
            query,
            oldTime,
            newTime,
            timeWindow,
            isFree,
            conflicts,
            suggestedSlot,
          },
        });
      } catch (err) {
        console.warn("Failed to parse calendar-card JSON:", err);
      }
    } else if (tagType === "gmail-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          // If JSON had line breaks or formatting issues
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const emailsList: GmailEmailItem[] = Array.isArray(parsed.emails)
          ? parsed.emails
          : Array.isArray(parsed)
          ? parsed
          : [];
        const count = typeof parsed.count === "number" ? parsed.count : emailsList.length;
        const subtitle = typeof parsed.subtitle === "string" ? parsed.subtitle : undefined;
        const mode =
          parsed.mode === "read"
            ? "read"
            : parsed.mode === "search" || parsed.query
            ? "search"
            : "unread";
        const query = typeof parsed.query === "string" ? parsed.query : undefined;
        parts.push({
          type: "gmail",
          data: {
            count,
            emails: emailsList,
            subtitle,
            mode,
            query,
            id: typeof parsed.id === "string" || typeof parsed.id === "number" ? String(parsed.id) : undefined,
            sender: typeof parsed.sender === "string" ? parsed.sender : undefined,
            email: typeof parsed.email === "string" ? parsed.email : undefined,
            date: typeof parsed.date === "string" ? parsed.date : undefined,
            subject: typeof parsed.subject === "string" ? parsed.subject : undefined,
            summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
            avatar: typeof parsed.avatar === "string" ? parsed.avatar : undefined,
          },
        });
      } catch (err) {
        console.warn("Failed to parse gmail-card JSON:", err);
      }
    } else if (tagType === "location-card") {
      let lat = 0;
      let lon = 0;
      let title = "";

      const tokens = rawPayload.split("|");
      for (const token of tokens) {
        const [k, ...vParts] = token.split("=");
        const key = k?.trim().toLowerCase();
        const val = vParts.join("=").trim();
        if (key === "lat") {
          lat = parseFloat(val) || 0;
        } else if (key === "lon" || key === "lng") {
          lon = parseFloat(val) || 0;
        } else if (key === "title" || key === "name") {
          title = val;
        }
      }

      if (!lat && !lon) {
        const fallbackParts = rawPayload.split(/[,|]/);
        if (fallbackParts.length >= 2) {
          lat = parseFloat(fallbackParts[0]) || 0;
          lon = parseFloat(fallbackParts[1]) || 0;
          if (fallbackParts.length >= 3) {
            title = fallbackParts.slice(2).join(", ").trim();
          }
        }
      }

      if (lat !== 0 || lon !== 0) {
        parts.push({ type: "location", data: { lat, lon, title } });
      }
    } else if (tagType === "weather-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        parts.push({
          type: "weather",
          data: {
            location: String(parsed.location || "Unknown"),
            temp: Number(parsed.temp ?? 0),
            tempHigh: typeof parsed.tempHigh === "number" ? parsed.tempHigh : undefined,
            tempLow: typeof parsed.tempLow === "number" ? parsed.tempLow : undefined,
            unit: parsed.unit ? String(parsed.unit) : "C",
            condition: String(parsed.condition || "Cloudy"),
            conditionKey: String(parsed.conditionKey || "cloudy"),
            weatherCode: typeof parsed.weatherCode === "number" ? parsed.weatherCode : undefined,
            isDay: typeof parsed.isDay === "boolean" ? parsed.isDay : undefined,
          },
        });
      } catch (err) {
        console.warn("Failed to parse weather-card JSON:", err);
      }
    } else if (tagType === "system-slider") {
      let sliderType: "volume" | "brightness" = "volume";
      let level = 50;
      let muted = false;
      if (rawPayload.startsWith("{")) {
        try {
          const parsed = JSON.parse(rawPayload);
          sliderType = parsed.type === "brightness" ? "brightness" : "volume";
          level = typeof parsed.level === "number" ? parsed.level : parseInt(parsed.level, 10) || 0;
          muted = Boolean(parsed.muted);
        } catch (err) {
          console.warn("Failed to parse system-slider JSON:", err);
        }
      } else {
        const tokens = rawPayload.split("|");
        for (const token of tokens) {
          const [k, ...vParts] = token.split("=");
          const key = k?.trim().toLowerCase();
          const val = vParts.join("=").trim();
          if (key === "type") {
            sliderType = val.toLowerCase() === "brightness" ? "brightness" : "volume";
          } else if (key === "level") {
            level = parseInt(val, 10) || 0;
          } else if (key === "muted") {
            muted = val.toLowerCase() === "true" || val === "1";
          }
        }
      }
      parts.push({
        type: "system_slider",
        data: { type: sliderType, level, muted },
      });
    } else {
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
    }
    lastIndex = embedRegex.lastIndex;
  }

  const remaining = rawText.slice(lastIndex);
  if (remaining) {
    const partialMatch = /::(media-(?:gallery|strip)|location-card|gmail-card|calendar-card|system-slider|weather-card)\[[\s\S]*$/i.exec(remaining);
    if (partialMatch && isStreaming) {
      const textBeforePartial = remaining.slice(0, partialMatch.index);
      if (textBeforePartial) {
        parts.push({ type: "text", text: textBeforePartial });
      }
      if (partialMatch[1].toLowerCase().startsWith("media")) {
        parts.push({ type: "loading_gallery" });
      } else if (partialMatch[1].toLowerCase().startsWith("location")) {
        parts.push({ type: "loading_location" });
      }
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
  activeConnector = null,
  isStreaming = false,
  onClearResponse,
  contentRef,
  activeAudioTurnId = null,
  isAudioPlaying = false,
  onToggleTts,
  isVoiceActive,
  onToggleVoice,
  isExitingVoice,
  isEnteringVoice,
  audioMeter = { level: 0, bass: 0, mid: 0, high: 0 },
  isRecording = false,
  onStartRecording: _onStartRecording,
  onStopRecording: _onStopRecording,
  onHardwareChange,
}) => {
  void _onStartRecording;
  void _onStopRecording;
  const isConnecting = Boolean(
    activeUiTag && activeUiTag.toLowerCase().includes("connecting")
  );
  const activeConnectorMeta = isConnecting ? resolveConnectorMeta(activeUiTag, activeConnector) : null;
  const [inputText, setInputText] = useState("");
  const [localVoiceActive, setLocalVoiceActive] = useState(false);
  const voiceActive = isVoiceActive !== undefined ? isVoiceActive : localVoiceActive;

  const [localExitingVoice, setLocalExitingVoice] = useState(false);
  const localExitingTimerRef = useRef<number | null>(null);
  const effectiveExitingVoice = isExitingVoice !== undefined ? isExitingVoice : localExitingVoice;

  const [localEnteringVoice, setLocalEnteringVoice] = useState(false);
  const localEnteringTimerRef = useRef<number | null>(null);
  const effectiveEnteringVoice = isEnteringVoice !== undefined ? isEnteringVoice : localEnteringVoice;

  const [isExpandedVoiceReturning, setIsExpandedVoiceReturning] = useState(false);
  const expandedVoiceReturnTimerRef = useRef<number | null>(null);
  const [isExpandedVoiceCascading, setIsExpandedVoiceCascading] = useState(false);
  const expandedVoiceCascadeTimerRef = useRef<number | null>(null);

  const toggleVoiceMode = (active: boolean) => {
    const isResponding = pillMode === "responding";

    if (!active && voiceActive) {
      if (isResponding) {
        setIsExpandedVoiceCascading(false);
        if (expandedVoiceCascadeTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceCascadeTimerRef.current);
          expandedVoiceCascadeTimerRef.current = null;
        }
        setIsExpandedVoiceReturning(true);
        if (expandedVoiceReturnTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceReturnTimerRef.current);
        }
        expandedVoiceReturnTimerRef.current = window.setTimeout(() => {
          setIsExpandedVoiceReturning(false);
          expandedVoiceReturnTimerRef.current = null;
        }, 520);
      } else {
        setLocalEnteringVoice(false);
        if (localEnteringTimerRef.current !== null) {
          window.clearTimeout(localEnteringTimerRef.current);
          localEnteringTimerRef.current = null;
        }
        setLocalExitingVoice(true);
        if (localExitingTimerRef.current !== null) {
          window.clearTimeout(localExitingTimerRef.current);
        }
        localExitingTimerRef.current = window.setTimeout(() => {
          setLocalExitingVoice(false);
          localExitingTimerRef.current = null;
        }, 480);
      }
    } else if (active) {
      if (isResponding) {
        setIsExpandedVoiceReturning(false);
        if (expandedVoiceReturnTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceReturnTimerRef.current);
          expandedVoiceReturnTimerRef.current = null;
        }
        setIsExpandedVoiceCascading(true);
        if (expandedVoiceCascadeTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceCascadeTimerRef.current);
        }
        expandedVoiceCascadeTimerRef.current = window.setTimeout(() => {
          setIsExpandedVoiceCascading(false);
          expandedVoiceCascadeTimerRef.current = null;
        }, 320);
        followupInputRef.current?.blur();
        setIsInputFocused(false);
      } else {
        setLocalExitingVoice(false);
        if (localExitingTimerRef.current !== null) {
          window.clearTimeout(localExitingTimerRef.current);
          localExitingTimerRef.current = null;
        }
        setLocalEnteringVoice(true);
        if (localEnteringTimerRef.current !== null) {
          window.clearTimeout(localEnteringTimerRef.current);
        }
        localEnteringTimerRef.current = window.setTimeout(() => {
          setLocalEnteringVoice(false);
          localEnteringTimerRef.current = null;
        }, 160);
      }
    }
    setLocalVoiceActive(active);
    if (onToggleVoice) onToggleVoice(active);
  };

  useEffect(() => {
    return () => {
      if (localExitingTimerRef.current !== null) {
        window.clearTimeout(localExitingTimerRef.current);
      }
      if (localEnteringTimerRef.current !== null) {
        window.clearTimeout(localEnteringTimerRef.current);
      }
      if (expandedVoiceReturnTimerRef.current !== null) {
        window.clearTimeout(expandedVoiceReturnTimerRef.current);
      }
      if (expandedVoiceCascadeTimerRef.current !== null) {
        window.clearTimeout(expandedVoiceCascadeTimerRef.current);
      }
    };
  }, []);

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
  const hasReplyText = hasTurns || Boolean((responseMessage && responseMessage.length > 0) || isStreaming || followupThinkingPrompt);
  const isThinking = Boolean(!hasReplyText && (activeUiTag || isSubmitting));

  const pillMode: "idle" | "listening" | "thinking" | "responding" = hasReplyText
    ? "responding"
    : isThinking
    ? "thinking"
    : voiceActive
    ? "listening"
    : "idle";

  const showReplyWindow = pillMode === "responding";

  // Shared Apple Siri Fluid Aurora Vocal Energy & Intensity
  const rawVocal = Math.max(
    audioMeter.level || 0,
    (audioMeter.mid || 0) * 0.95,
    (audioMeter.bass || 0) * 0.75
  );
  const voiceIntensity = isRecording
    ? Math.min(1.0, Math.pow(rawVocal * 2.0, 0.75))
    : 0;
  const activeScaleY = 1 + voiceIntensity * 0.48;
  const activeScaleX = 1 + voiceIntensity * 0.09;

  // Controls (minimize button and command bar) are visible on hover, when input is focused/typed, or in-stream thinking (text mode only)
  const isControlsVisible = Boolean(
    !voiceActive && (isHovered || isInputFocused || inputText.trim().length > 0 || followupThinkingPrompt)
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

  // Global key listener: Space to exit voice in responding mode, Escape to collapse
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") {
        if (pillMode === "responding" && voiceActive) {
          e.preventDefault();
          toggleVoiceMode(false);
          return;
        }
      }
      if (e.key === "Escape") {
        if (voiceActive) {
          toggleVoiceMode(false);
        } else if (pillMode === "responding" && onClearResponse) {
          onClearResponse();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [voiceActive, pillMode, onClearResponse]);

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

  // Track exact pixel dimensions of .siri-unified-stream so the SVG button-lens filter
  // blurs text ONLY inside the 4 clear-glass buttons while keeping text razor-sharp outside them
  const [streamBox, setStreamBox] = useState<{ w: number; h: number; topOffset: number }>({
    w: 429,
    h: 360,
    topOffset: 0,
  });

  useLayoutEffect(() => {
    const el = streamContainerRef.current;
    if (!el) return;

    el.style.maskImage = "none";
    el.style.webkitMaskImage = "none";

    const updateBox = () => {
      const w = el.clientWidth || 429;
      const h = el.clientHeight || 360;
      const topOffset = 16 - el.offsetTop;
      setStreamBox((prev) =>
        prev.w === w && prev.h === h && prev.topOffset === topOffset
          ? prev
          : { w, h, topOffset }
      );
    };

    updateBox();

    const resizeObserver = new ResizeObserver(() => {
      updateBox();
    });
    resizeObserver.observe(el);

    return () => {
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
    const isMulti = scrollH > (minH + 6) || val.includes("\r\n");
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
      if (showReplyWindow && onClearResponse) {
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
      .replace(/\bgmail\b/gi, "Gmail")
      .replace(/\byoutube\b/gi, "YouTube")
      .replace(/\bspotify\b/gi, "Spotify")
      .replace(/\bgoogle calendar\b/gi, "Google Calendar")
      .replace(/\bgps\b/gi, "GPS")
      .replace(/\bobsidian\b/gi, "Obsidian")
      .replace(/\bnotion\b/gi, "Notion");
  };

  const lensMaskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${streamBox.w}" height="${streamBox.h}" viewBox="0 0 ${streamBox.w} ${streamBox.h}"><circle cx="${streamBox.w - 24}" cy="${streamBox.topOffset + 24}" r="24" fill="white"/>${
    !voiceActive
      ? `<circle cx="24" cy="${streamBox.h - 24}" r="24" fill="white"/><rect x="60" y="${streamBox.h - 48}" width="${Math.max(0, streamBox.w - 120)}" height="48" rx="24" ry="24" fill="white"/><circle cx="${streamBox.w - 24}" cy="${streamBox.h - 24}" r="24" fill="white"/>`
      : ""
  }</svg>`;
  const lensMaskDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(lensMaskSvg)}`;

  return (
    <div className="chat-pill-anchor">
      {/* Colourless Clear Glass Button-Lens Filter:
          Erases sharp text inside the 4 button shapes and replaces it with pure colourless blurred text */}
      <svg
        width="0"
        height="0"
        style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
        aria-hidden="true"
      >
        <defs>
          <filter
            id="aiden-stream-lens-blur"
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={streamBox.w}
            height={streamBox.h}
            colorInterpolationFilters="sRGB"
          >
            {/* 1. Exact pixel mask of the 4 rounded buttons ([Minimize], [+], [Ask Aiden], [Mic]) */}
            <feImage
              href={lensMaskDataUri}
              x="0"
              y="0"
              width={streamBox.w}
              height={streamBox.h}
              preserveAspectRatio="none"
              result="buttonMask"
            />

            {/* 2. Refract + heavily blur the stream text/entities on its native 100% transparent background (zero black fill!) */}
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.05"
              numOctaves="2"
              seed="7"
              result="glassWave"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="glassWave"
              scale="18"
              xChannelSelector="R"
              yChannelSelector="G"
              result="refracted"
            />
            <feGaussianBlur in="refracted" stdDeviation="8" result="blurredRaw" />

            {/* Soften blurred text opacity slightly so "Ask Aiden" and button icons pop crisply */}
            <feComponentTransfer in="blurredRaw" result="blurredSoft">
              <feFuncA type="linear" slope="0.55" intercept="0" />
            </feComponentTransfer>

            {/* 3. Keep blurred text ONLY inside the 4 button shapes */}
            <feComposite
              in="blurredSoft"
              in2="buttonMask"
              operator="in"
              result="blurredInButtons"
            />

            {/* 4. Keep sharp text ONLY outside the 4 button shapes (100% erases sharp text behind the buttons!) */}
            <feComposite
              in="SourceGraphic"
              in2="buttonMask"
              operator="out"
              result="sharpOutsideButtons"
            />

            {/* 5. Merge sharp outside text + colourless blurred inside-button text */}
            <feMerge>
              <feMergeNode in="sharpOutsideButtons" />
              <feMergeNode in="blurredInButtons" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <div ref={contentRef} className={`chat-pill-wrapper ${isAwake ? "awake" : ""}`}>
        <div
          className={`siri-unified-pill siri-glass mode-${pillMode} ${
            effectiveExitingVoice && pillMode === "idle" ? "exiting-voice" : ""
          } ${
            pillMode === "responding" && voiceActive ? "expanded-voice-active" : ""
          } ${
            isExpandedVoiceReturning ? "expanded-voice-returning" : ""
          } ${
            isExpandedVoiceCascading ? "expanded-voice-cascading" : ""
          } ${
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
          {(pillMode === "idle" || (effectiveEnteringVoice && pillMode !== "responding")) && (
            <>
              <div
                className={`siri-pill-input-wrap ${
                  effectiveEnteringVoice ? "entering-voice" : ""
                }`}
              >
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
                className={`siri-idle-bare-mic-btn ${
                  effectiveEnteringVoice ? "entering-voice" : ""
                }`}
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

          {/* 1.5. VOICE / LISTENING STATE (Compact Plump Capsule with Apple Siri Aurora) */}
          {pillMode === "listening" && !effectiveEnteringVoice && (
            <div
              className="siri-listening-content"
              onClick={(e) => {
                e.stopPropagation();
                toggleVoiceMode(false);
              }}
              title="Hold Shift to speak • Click or press Esc to return to Search"
            >
              {/* Apple Siri Fluid Aurora Edge Glow (Compact Capsule Mode) */}
              <div
                className={`siri-aurora-edge-container compact ${isRecording ? "recording" : "idle"}`}
                aria-hidden="true"
              >
                {/* 1. Idle Grey/White Smoky Aurora Layer (Gentle undulating hill) */}
                <div className="siri-aurora-layer idle-layer">
                  <div className="siri-aurora-cloud-stage">
                    <div className="siri-aurora-cloud idle-cloud-1" />
                    <div className="siri-aurora-cloud idle-cloud-2" />
                    <div className="siri-aurora-cloud idle-cloud-3" />
                    <div className="siri-aurora-cloud idle-cloud-crest" />
                  </div>
                </div>

                {/* 2. Active Cyan/Blue/White Siri Intelligence Aurora Layer (Vibrant, voice-reactive) */}
                <div
                  className="siri-aurora-layer active-layer"
                  style={{
                    transform: `scaleY(${activeScaleY.toFixed(3)}) scaleX(${activeScaleX.toFixed(3)})`,
                  }}
                >
                  <div className="siri-aurora-cloud-stage">
                    <div className="siri-aurora-cloud active-cloud-cyan" />
                    <div className="siri-aurora-cloud active-cloud-blue" />
                    <div className="siri-aurora-cloud active-cloud-white" />
                    <div className="siri-aurora-cloud active-cloud-amber" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. THINKING STATE (Pill shrinks by 1/3, glowing pulse, shows status tag) */}
          {pillMode === "thinking" && (
            <div className="siri-thinking-content">
              <div className="siri-icon-morph-anchor">
                <span
                  className={`siri-apple-constellation ${isConnecting ? "is-imploded" : ""}`}
                  aria-hidden="true"
                >
                  <AppleConstellationSpinner />
                </span>
                {activeConnectorMeta && (
                  <div className={`siri-connector-sine-wrapper ${isConnecting ? "is-active" : ""}`}>
                    <img
                      src={activeConnectorMeta.icon}
                      alt={activeConnectorMeta.name}
                      className="siri-connector-sine-img"
                    />
                  </div>
                )}
              </div>
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
                    <rect x="8" y="8" width="13" height="12" rx="2.5" fill="currentColor" fillOpacity="0.2" />
                  </svg>
                </button>
              )}

              {activeUiTag && !followupThinkingPrompt && (
                <div className="siri-responding-header">
                  <div className="siri-responding-header-left">
                    <div className="siri-card-status-tag" key={activeUiTag}>
                      <div className="siri-icon-morph-anchor small">
                        <span
                          className={`siri-apple-constellation small ${isConnecting ? "is-imploded" : ""}`}
                          aria-hidden="true"
                        >
                          <AppleConstellationSpinner />
                        </span>
                        {activeConnectorMeta && (
                          <div className={`siri-connector-sine-wrapper small ${isConnecting ? "is-active" : ""}`}>
                            <img
                              src={activeConnectorMeta.icon}
                              alt={activeConnectorMeta.name}
                              className="siri-connector-sine-img"
                            />
                          </div>
                        )}
                      </div>
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
                              <div key={idx} className="siri-media-gallery loading single-item">
                                <div className="siri-media-skeleton" />
                              </div>
                            );
                          }

                          if (part.type === "location") {
                            return (
                              <LocationCard
                                key={idx}
                                lat={part.data.lat}
                                lon={part.data.lon}
                                title={part.data.title}
                              />
                            );
                          }

                          if (part.type === "loading_location") {
                            return (
                              <div key={idx} className="siri-location-card loading">
                                <div className="siri-location-skeleton" />
                              </div>
                            );
                          }

                          if (part.type === "gmail") {
                            return (
                              <GmailCard
                                key={idx}
                                count={part.data.count}
                                emails={part.data.emails}
                                subtitle={part.data.subtitle}
                                mode={part.data.mode}
                                query={part.data.query}
                                id={part.data.id}
                                sender={part.data.sender}
                                email={part.data.email}
                                date={part.data.date}
                                subject={part.data.subject}
                                summary={part.data.summary}
                                avatar={part.data.avatar}
                                onSelectEmail={(item) => {
                                  if (onSendMessage && item.id) {
                                    onSendMessage(`Read email ${item.id}`, false);
                                  }
                                }}
                                onAction={(action, emailId, senderName) => {
                                  if (!onSendMessage) return;
                                  if (action === "reply") {
                                    onSendMessage(`Reply to email from ${senderName || "sender"}: `, true);
                                  } else if (action === "archive") {
                                    onSendMessage(`Archive email ${emailId || ""}`, false);
                                  } else if (action === "mark_unread") {
                                    onSendMessage(`Mark email ${emailId || ""} as unread`, false);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "calendar") {
                            return (
                              <CalendarCard
                                key={idx}
                                mode={part.data.mode}
                                label={part.data.label}
                                count={part.data.count}
                                events={part.data.events}
                                event={part.data.event}
                                query={part.data.query}
                                oldTime={part.data.oldTime}
                                newTime={part.data.newTime}
                                timeWindow={part.data.timeWindow}
                                isFree={part.data.isFree}
                                conflicts={part.data.conflicts}
                                suggestedSlot={part.data.suggestedSlot}
                                onAction={(action, payload) => {
                                  if (!onSendMessage) return;
                                  if (action === "reschedule") {
                                    const title = payload?.summary || "event";
                                    onSendMessage(`Reschedule "${title}" to `, true);
                                  } else if (action === "schedule") {
                                    onSendMessage(`Schedule event for ${payload || "tomorrow"}: `, true);
                                  } else if (action === "book_suggested") {
                                    onSendMessage(`Book event during ${payload}`, true);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "weather") {
                            return (
                              <WeatherCard
                                key={idx}
                                location={part.data.location}
                                temp={part.data.temp}
                                tempHigh={part.data.tempHigh}
                                tempLow={part.data.tempLow}
                                unit={part.data.unit}
                                condition={part.data.condition}
                                conditionKey={part.data.conditionKey}
                                weatherCode={part.data.weatherCode}
                                isDay={part.data.isDay}
                              />
                            );
                          }

                          if (part.type === "system_slider") {
                            return (
                              <SystemSlider
                                key={idx}
                                type={part.data.type}
                                level={part.data.level}
                                muted={part.data.muted}
                                onHardwareChange={onHardwareChange}
                              />
                            );
                          }
                          return (
                            <div key={idx} className={`siri-media-gallery ${part.items.length === 1 ? "single-item" : ""}`}>
                              {part.items.map((item, imgIdx) => (
                                <div
                                  key={imgIdx}
                                  className="siri-media-card"
                                  title={item.title || "Image"}
                                >
                                  <img src={item.url} alt={item.title || "Image"} className="siri-media-img" />
                                  {item.title && (
                                    <div className="siri-media-caption-bar">
                                      <span className="siri-media-caption">{item.title}</span>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        })}

                        {/* Symbiote Connector Footer: Shows active connectors utilized in this turn */}
                        {!turn.isStreaming && turn.connectors && turn.connectors.length > 0 && (
                          <div className="siri-turn-symbiote-footer">
                            {turn.connectors.map((connKey) => {
                              const meta = resolveConnectorMeta(connKey, connKey);
                              if (!meta) return null;
                              return (
                                <div key={connKey} className="siri-symbiote-badge" title={`Connected via ${meta.name} connector`}>
                                  <img src={meta.icon} alt={meta.name} className="siri-symbiote-icon" />
                                  <span className="siri-symbiote-label">Connected to {meta.name}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
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
                      <div className="siri-icon-morph-anchor">
                        <span
                          className={`siri-apple-constellation ${isConnecting ? "is-imploded" : ""}`}
                          aria-hidden="true"
                        >
                          <AppleConstellationSpinner />
                        </span>
                        {activeConnectorMeta && (
                          <div className={`siri-connector-sine-wrapper ${isConnecting ? "is-active" : ""}`}>
                            <img
                              src={activeConnectorMeta.icon}
                              alt={activeConnectorMeta.name}
                              className="siri-connector-sine-img"
                            />
                          </div>
                        )}
                      </div>
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

              {/* Apple Siri Fluid Aurora Edge Glow (Expanded UI Voice Mode) */}
              {voiceActive && pillMode === "responding" && (
                <div
                  className={`siri-aurora-edge-container ${isRecording ? "recording" : "idle"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleVoiceMode(false);
                  }}
                  title="Press Space or click to exit Voice Mode"
                  aria-hidden="true"
                >
                  {/* 1. Idle Grey/White Smoky Aurora Layer (Slow, relaxed, undulating) */}
                  <div className="siri-aurora-layer idle-layer">
                    <div className="siri-aurora-cloud-stage">
                      <div className="siri-aurora-cloud idle-cloud-1" />
                      <div className="siri-aurora-cloud idle-cloud-2" />
                      <div className="siri-aurora-cloud idle-cloud-3" />
                      <div className="siri-aurora-cloud idle-cloud-crest" />
                    </div>
                  </div>

                  {/* 2. Active Cyan/Blue/White Siri Intelligence Aurora Layer (Vibrant, voice-reactive) */}
                  <div
                    className="siri-aurora-layer active-layer"
                    style={{
                      transform: `scaleY(${activeScaleY.toFixed(3)}) scaleX(${activeScaleX.toFixed(3)})`,
                    }}
                  >
                    <div className="siri-aurora-cloud-stage">
                      <div className="siri-aurora-cloud active-cloud-cyan" />
                      <div className="siri-aurora-cloud active-cloud-blue" />
                      <div className="siri-aurora-cloud active-cloud-white" />
                      <div className="siri-aurora-cloud active-cloud-amber" />
                    </div>
                  </div>
                </div>
              )}

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
                          if (onClearResponse) {
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
                    title="Dictate with Siri (Press Space to cancel)"
                    aria-label="Voice input"
                    tabIndex={isControlsVisible ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleVoiceMode(true);
                    }}
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
  const [activeConnector, setActiveConnector] = useState<string | null>(null);
  const currentTurnConnectorsRef = useRef<Set<string>>(new Set());
  const [isStreaming, setIsStreaming] = useState(false);
  const [isMaxHeight, setIsMaxHeight] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef<boolean>(false);
  isRecordingRef.current = isRecording;
  const [isExitingVoice, setIsExitingVoice] = useState(false);
  const exitingVoiceTimerRef = useRef<number | null>(null);
  const [isEnteringVoice, setIsEnteringVoice] = useState(false);
  const enteringVoiceTimerRef = useRef<number | null>(null);
  const [audioMeter, setAudioMeter] = useState({ level: 0, bass: 0, mid: 0, high: 0 });
  const wasOriginVoiceRef = useRef<boolean>(false);

  const handleToggleVoice = useCallback((active: boolean, skipSocket?: boolean) => {
    if (active) {
      wasOriginVoiceRef.current = true;
      setActiveUiTag(null);
    } else {
      wasOriginVoiceRef.current = false;
      setActiveUiTag(null);
    }

    if (!active) {
      isRecordingRef.current = false;
      setIsRecording(false);
    }
    if (!skipSocket && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: active ? "voice_arm" : "voice_disarm" }));
    }

    setIsVoiceActive((prev) => {
      const isResponding = turnsRef.current.length > 0 || Boolean(followupThinkingPromptRef.current);
      if (isResponding) {
        return active;
      }

      if (prev && !active) {
        setIsEnteringVoice(false);
        if (enteringVoiceTimerRef.current !== null) {
          window.clearTimeout(enteringVoiceTimerRef.current);
          enteringVoiceTimerRef.current = null;
        }
        setIsExitingVoice(true);
        if (exitingVoiceTimerRef.current !== null) {
          window.clearTimeout(exitingVoiceTimerRef.current);
        }
        exitingVoiceTimerRef.current = window.setTimeout(() => {
          setIsExitingVoice(false);
          exitingVoiceTimerRef.current = null;
        }, 480);
      } else if (active) {
        setIsExitingVoice(false);
        if (exitingVoiceTimerRef.current !== null) {
          window.clearTimeout(exitingVoiceTimerRef.current);
          exitingVoiceTimerRef.current = null;
        }
        setIsEnteringVoice(true);
        if (enteringVoiceTimerRef.current !== null) {
          window.clearTimeout(enteringVoiceTimerRef.current);
        }
        enteringVoiceTimerRef.current = window.setTimeout(() => {
          setIsEnteringVoice(false);
          enteringVoiceTimerRef.current = null;
        }, 160);
      }
      return active;
    });
  }, []);

  const handleStartRecording = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "recording_start" }));
    }
    isRecordingRef.current = true;
    setIsRecording(true);
    setActiveUiTag(null);
  }, []);

  const handleStopRecording = useCallback(() => {
    if (!isRecordingRef.current) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "recording_stop" }));
    }
    isRecordingRef.current = false;
    setIsRecording(false);
    // Instant 0ms visual feedback: transition immediately into Thinking mode!
    setActiveUiTag("Thinking");
  }, []);

  // Global Push-to-Talk Shift key listener when in Voice Mode
  useEffect(() => {
    const handleShiftDown = (e: KeyboardEvent) => {
      if ((e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") && !e.repeat) {
        if (isVoiceActive && !isRecordingRef.current) {
          handleStartRecording();
        }
      }
    };

    const handleShiftUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (isVoiceActive && isRecordingRef.current) {
          handleStopRecording();
        }
      }
    };

    window.addEventListener("keydown", handleShiftDown);
    window.addEventListener("keyup", handleShiftUp);
    return () => {
      window.removeEventListener("keydown", handleShiftDown);
      window.removeEventListener("keyup", handleShiftUp);
    };
  }, [isVoiceActive, handleStartRecording, handleStopRecording]);

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
    setIsExitingVoice(false);
    if (exitingVoiceTimerRef.current !== null) {
      window.clearTimeout(exitingVoiceTimerRef.current);
      exitingVoiceTimerRef.current = null;
    }
    setIsEnteringVoice(false);
    if (enteringVoiceTimerRef.current !== null) {
      window.clearTimeout(enteringVoiceTimerRef.current);
      enteringVoiceTimerRef.current = null;
    }
    currentTurnIdRef.current = null;
    followupThinkingPromptRef.current = null;
    setFollowupThinkingPrompt(null);
    turnsRef.current = [];
    setTurns([]);
    setActiveUiTag(null);
    setIsStreaming(false);
    setIsMaxHeight(false);
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
    lastLineEmittedTimeRef.current = 0;
  };

  const hasReplyText = turns.length > 0 || Boolean(followupThinkingPrompt) || isStreaming;
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
      invoke("set_chat_pill_state", { isAwake: true })
        .then(() => {
          requestAnimationFrame(() => measureAndSyncShape());
        })
        .catch(() => {});
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

  // Maintain latest mode ref for stable measureAndSyncShape identity
  const currentModeRef = useRef(currentMode);
  currentModeRef.current = currentMode;

  // Dynamic Real-Time Shape Measurement & Synchronization (Option A)
  const morphRafRef = useRef<number | null>(null);

  const measureAndSyncShape = useCallback((targetWinHeight?: number) => {
    if (!isAwake) return;
    const wrapper = contentRef.current;
    if (!wrapper) return;
    const pillEl = (wrapper.querySelector(".siri-unified-pill") as HTMLElement) ?? wrapper;
    const rect = pillEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const shapeX = Math.round(rect.left);
    const shapeY = Math.round(rect.top);
    const shapeW = Math.round(rect.width);
    const shapeH = Math.round(rect.height);

    const mode = currentModeRef.current;
    const shapeR = mode === "responding" ? (shapeH > 80 ? 28 : 30) : Math.round(shapeH / 2);

    const winH = targetWinHeight ?? (
      mode === "responding"
        ? Math.max(130, Math.ceil(shapeH + 70))
        : 150
    );

    invoke("set_chat_pill_size", {
      width: 640,
      height: winH,
      pillMode: mode,
      shapeX,
      shapeY,
      shapeW,
      shapeH,
      shapeR,
    }).catch(() => {});
  }, [isAwake]);

  // Launch smooth frame-by-frame rAF tracker during morph transitions (550ms)
  const startMorphTracking = useCallback((durationMs = 550) => {
    if (morphRafRef.current !== null) {
      cancelAnimationFrame(morphRafRef.current);
    }
    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      measureAndSyncShape();
      if (elapsed < durationMs) {
        morphRafRef.current = requestAnimationFrame(tick);
      } else {
        morphRafRef.current = null;
        measureAndSyncShape();
      }
    };

    morphRafRef.current = requestAnimationFrame(tick);
  }, [measureAndSyncShape]);

  // Whenever mode changes, start continuous morph tracking
  useEffect(() => {
    if (!isAwake) return;
    startMorphTracking(550);
    return () => {
      if (morphRafRef.current !== null) {
        cancelAnimationFrame(morphRafRef.current);
      }
    };
  }, [currentMode, isAwake, startMorphTracking]);

  // Manage window resizing and ongoing height changes (e.g. streaming or hover in responding mode)
  useEffect(() => {
    if (!isAwake) return;
    const el = contentRef.current;
    if (!el) return;

    measureAndSyncShape();

    const observer = new ResizeObserver(() => {
      measureAndSyncShape();
    });

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, [isAwake, measureAndSyncShape]);

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

            if (msgType === "audio_meter") {
              setAudioMeter({
                level: Number(data.level || 0),
                bass: Number(data.bass || 0),
                mid: Number(data.mid || 0),
                high: Number(data.high || 0),
              });
            } else if (msgType === "voice_recording") {
              const rec = Boolean(data.isRecording);
              const wasRecording = isRecordingRef.current;
              isRecordingRef.current = rec;
              setIsRecording(rec);
              if (rec) {
                setActiveUiTag(null);
              } else if (wasRecording) {
                // Only show Thinking if we were actively recording audio and just released Shift
                setActiveUiTag("Thinking");
              } else {
                // Not recording and wasn't recording (e.g. idle arming) -> stay in listening mode
                setActiveUiTag(null);
              }
            } else if (msgType === "voice_status") {
              const status = String(data.status || "");
              if (status === "transcribing") {
                setActiveUiTag("Thinking");
              } else if (status === "armed" || status === "idle") {
                // When armed/idle and not streaming a reply, clear thinking tag so we stay in listening mode
                if (!isStreaming) {
                  setActiveUiTag(null);
                }
              }
            } else if (msgType === "voice_active") {
              const active = Boolean(data.active);
              handleToggleVoice(active, true);
            } else if (msgType === "voice_transcription") {
              const text = String(data.text || "").trim();
              if (text) {
                wasOriginVoiceRef.current = true;
                if (turnsRef.current.length > 0) {
                  // Turn 2+ in Voice Mode: append follow-up bubble & keep scrollable history just like Keyboard Mode
                  setIsMaxHeight(true);
                  followupThinkingPromptRef.current = text;
                  setFollowupThinkingPrompt(text);
                  setActiveUiTag("Thinking");
                } else {
                  // Turn 1 in Voice Mode: clean initial turn
                  followupThinkingPromptRef.current = null;
                  setFollowupThinkingPrompt(null);
                  setActiveUiTag("Thinking");
                  setIsMaxHeight(false);
                }
              }
            } else if (msgType === "state" || msgType === "state_change") {
              const nextAwake = Boolean(data.isAwake);
              setIsAwake(nextAwake);
            } else if (msgType === "ui_tag") {
              const tag = String(data.tag || "").trim();
              const connector = typeof data.connector === "string" ? data.connector : null;
              if (tag) {
                setActiveUiTag(tag);
                if (connector) {
                  setActiveConnector(connector);
                  currentTurnConnectorsRef.current.add(connector);
                } else {
                  const meta = resolveConnectorMeta(tag, null);
                  if (meta) {
                    currentTurnConnectorsRef.current.add(meta.key);
                  }
                }
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

              // Tracker: If originated from audio/mic mode, keep expanded UI in mic mode too
              if (wasOriginVoiceRef.current) {
                setIsVoiceActive(true);
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: "voice_arm" }));
                }
              }

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
              setActiveConnector(null);
              if (typeof data.fullContent === "string") {
                targetTextRef.current = data.fullContent;
              }
              const serverConnectors: string[] = Array.isArray(data.connectors) ? data.connectors : [];
              serverConnectors.forEach((c) => currentTurnConnectorsRef.current.add(c));
              const turnConnectorsList = Array.from(currentTurnConnectorsRef.current);
              if (currentTurnIdRef.current && turnConnectorsList.length > 0) {
                setTurns((prev) =>
                  prev.map((t) =>
                    t.id === currentTurnIdRef.current
                      ? { ...t, connectors: Array.from(new Set([...(t.connectors || []), ...turnConnectorsList])) }
                      : t
                  )
                );
              }
              currentTurnConnectorsRef.current.clear();
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
    currentTurnConnectorsRef.current.clear();
    setActiveConnector(null);
    setIsExitingVoice(false);
    if (exitingVoiceTimerRef.current !== null) {
      window.clearTimeout(exitingVoiceTimerRef.current);
      exitingVoiceTimerRef.current = null;
    }
    setIsEnteringVoice(false);
    if (enteringVoiceTimerRef.current !== null) {
      window.clearTimeout(enteringVoiceTimerRef.current);
      enteringVoiceTimerRef.current = null;
    }
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
      setActiveUiTag("Thinking");
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

  const handleHardwareChange = useCallback((action: "volume" | "brightness", level?: number, muted?: boolean) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "hardware_control",
          action,
          level,
          muted,
        })
      );
    }
  }, []);

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
        activeConnector={activeConnector}
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
        onHardwareChange={handleHardwareChange}
        activeAudioTurnId={activeAudioTurnId}
        isAudioPlaying={isAudioPlaying}
        onToggleTts={handleToggleTts}
        isVoiceActive={isVoiceActive}
        onToggleVoice={handleToggleVoice}
        isExitingVoice={isExitingVoice}
        isEnteringVoice={isEnteringVoice}
        audioMeter={audioMeter}
        isRecording={isRecording}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
      />
    </div>
  );
};
