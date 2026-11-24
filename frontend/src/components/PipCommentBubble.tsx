import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./PipCommentBubble.css";

export type PipBubbleKind =
  | "curious"
  | "annoyed"
  | "dizzy"
  | "surprised"
  | "happy"
  | "sleepy"
  | "shy"
  | "thinking"
  | "working"
  | "work_gear"
  | "done"
  | "music"
  | "music_eq"
  | "music_notes"
  | "music_vinyl"
  | "music_vibe"
  | "music_pause"
  | "music_bored"
  | "bat_plug"
  | "bat_unplug"
  | "bat_low"
  | "bat_full";

interface PipBubbleSyncPayload {
  kind?: PipBubbleKind | null;
  flipRight?: boolean;
  darkMode?: boolean;
  batteryPct?: number;
}

interface PipBubbleFlipPayload {
  flipRight?: boolean;
}

interface ChatPillThemePayload {
  isDarkMode?: boolean | null;
}

function renderBubbleGlyph(kind: PipBubbleKind | null, batteryPct: number): React.ReactNode {
  const fillW = Math.max(2, Math.round((Math.max(4, Math.min(100, batteryPct)) / 100) * 14));
  switch (kind) {
    case "curious":
      return <span className="pip-glyph-q">?</span>;
    case "annoyed":
      return (
        <span className="pip-glyph-grawlix">
          <span>#</span>
          <span>!</span>
          <span>!</span>
          <span>@</span>
          <span>!</span>
          <span>!</span>
        </span>
      );
    case "dizzy":
      return (
        <svg
          className="pip-glyph-dizzy-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinecap="round"
        >
          <path d="M12 12c0-1.6 1.5-2.6 3-2.2 2 .5 3 2.7 2.2 4.7-1 2.7-4.4 3.8-7 2.6-3.3-1.6-4.5-5.7-2.8-9 2.1-4 7.2-5.4 11.2-3.1" />
        </svg>
      );
    case "surprised":
      return <span className="pip-glyph-bang">!</span>;
    case "happy":
      return <span className="pip-glyph-heart">♥</span>;
    case "sleepy":
      return (
        <span className="pip-glyph-zzz">
          <span>z</span>
          <span>Z</span>
          <span>z</span>
        </span>
      );
    case "shy":
      return (
        <svg className="pip-glyph-sweat-svg" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.5C12 2.5 5.5 10.6 5.5 15.2C5.5 18.9 8.4 21.5 12 21.5C15.6 21.5 18.5 18.9 18.5 15.2C18.5 10.6 12 2.5 12 2.5ZM9.6 16.3C9.1 16.3 8.7 15.6 8.9 14.7C9.1 13.7 9.9 12.2 10.5 11.3C10.7 12.7 10.7 14.3 10.3 15.6C10.1 16.1 9.9 16.3 9.6 16.3Z" />
        </svg>
      );
    case "thinking":
      return (
        <span className="pip-glyph-dots">
          <span />
          <span />
          <span />
        </span>
      );
    case "working":
      return (
        <svg className="pip-glyph-spark-svg" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13.2 2L4.5 13.5H11.2L10 22L19.5 10.2H12.7L13.2 2Z" />
        </svg>
      );
    case "work_gear":
      return (
        <svg
          className="pip-glyph-work-gear-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.0"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "done":
      return (
        <svg
          className="pip-glyph-done-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 13l4 4L19 7" />
        </svg>
      );
    case "music":
      return <span className="pip-glyph-note">♪</span>;
    case "music_eq":
      return (
        <div className="pip-music-eq-wrap" aria-hidden="true">
          <span className="pip-music-eq-bar b1" />
          <span className="pip-music-eq-bar b2" />
          <span className="pip-music-eq-bar b3" />
          <span className="pip-music-eq-bar b4" />
        </div>
      );
    case "music_notes":
      return (
        <svg className="pip-music-notes-svg" viewBox="0 0 26 20" aria-hidden="true">
          <g className="pip-music-note-a">
            <path
              d="M9 13.8V4.2l7-1.5v8.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <ellipse cx="7.2" cy="14.2" rx="2.5" ry="2.0" />
            <ellipse cx="14.2" cy="12.2" rx="2.5" ry="2.0" />
          </g>
          <g className="pip-music-note-b">
            <path
              d="M21 11.4V4.5l3.2-0.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <ellipse cx="19.6" cy="11.8" rx="2.0" ry="1.6" />
          </g>
        </svg>
      );
    case "music_vinyl":
      return (
        <svg className="pip-music-vinyl-svg" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="pip-music-vinyl-disc" cx="12" cy="12" r="9.5" />
          <circle className="pip-music-vinyl-groove" cx="12" cy="12" r="6.8" />
          <path className="pip-music-vinyl-glint" d="M 6.2 8.5 A 6.8 6.8 0 0 1 9.5 5.8" />
          <circle className="pip-music-vinyl-label" cx="12" cy="12" r="3.4" />
          <circle cx="12" cy="12" r="1.0" fill="#0f172a" />
        </svg>
      );
    case "music_vibe":
      return (
        <svg className="pip-music-vibe-svg" viewBox="0 0 26 20" aria-hidden="true">
          <path
            className="pip-music-vibe-heart"
            d="M9.5 15.8 C9.5 15.8 3.5 11.8 3.5 7.6 C3.5 5.4 5.2 4 7.0 4 C8.2 4 9.1 4.7 9.5 5.5 C9.9 4.7 10.8 4 12.0 4 C13.8 4 15.5 5.4 15.5 7.6 C15.5 11.8 9.5 15.8 9.5 15.8 Z"
          />
          <path
            className="pip-music-vibe-star"
            d="M19.5 1.8 L20.7 5.2 L24.2 6.4 L20.7 7.6 L19.5 11.0 L18.3 7.6 L14.8 6.4 L18.3 5.2 Z"
          />
        </svg>
      );
    case "music_pause":
      return (
        <svg className="pip-music-pause-svg" viewBox="0 0 26 18" aria-hidden="true">
          <rect className="pip-music-pause-bar" x="5.5" y="3" width="3.8" height="12" rx="1.6" />
          <rect className="pip-music-pause-bar" x="12.2" y="3" width="3.8" height="12" rx="1.6" />
          <path
            className="pip-music-pause-note"
            d="M21.5 12.2V5.2l2.6-0.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle className="pip-music-pause-note" cx="20.4" cy="12.5" r="1.6" />
        </svg>
      );
    case "music_bored":
      return (
        <div className="pip-music-bored-dots" aria-hidden="true">
          <span className="pip-music-bored-dot" />
          <span className="pip-music-bored-dot" />
          <span className="pip-music-bored-dot" />
        </div>
      );
    case "bat_plug":
      return (
        <svg className="pip-bat-svg" viewBox="0 0 26 16" aria-hidden="true">
          <rect className="pip-bat-body" x="1.5" y="2.5" width="19" height="11" rx="2.6" />
          <rect className="pip-bat-nub" x="21.5" y="5.5" width="2.2" height="5" rx="1" />
          <rect
            className="pip-bat-fill-green"
            x="3.5"
            y="4.5"
            width={Math.max(8, fillW)}
            height="7"
            rx="1.4"
          />
          <path
            className="pip-bat-bolt"
            d="M 11.8 1.5 L 7.6 8.2 H 11.0 L 10.1 14.5 L 14.6 7.5 H 11.2 Z"
          />
        </svg>
      );
    case "bat_unplug":
      return (
        <svg className="pip-bat-svg" viewBox="0 0 26 16" aria-hidden="true">
          <rect className="pip-bat-body" x="1.5" y="2.5" width="19" height="11" rx="2.6" />
          <rect className="pip-bat-nub" x="21.5" y="5.5" width="2.2" height="5" rx="1" />
          <rect className="pip-bat-fill-unplug" x="3.5" y="4.5" width={fillW} height="7" rx="1.4" />
          <path className="pip-bat-unplug-slash" d="M 18 1.5 L 22.5 5 M 22.5 1.5 L 18 5" />
        </svg>
      );
    case "bat_low":
      return (
        <svg className="pip-bat-svg" viewBox="0 0 26 16" aria-hidden="true">
          <rect className="pip-bat-body low-outline" x="1.5" y="2.5" width="19" height="11" rx="2.6" />
          <rect className="pip-bat-nub low-outline" x="21.5" y="5.5" width="2.2" height="5" rx="1" />
          <rect className="pip-bat-fill-red" x="3.5" y="4.5" width="3.5" height="7" rx="1" />
          <rect className="pip-bat-fill-red" x="12.2" y="4.6" width="1.8" height="4.2" rx="0.9" />
          <circle className="pip-bat-fill-red" cx="13.1" cy="10.6" r="1" />
        </svg>
      );
    case "bat_full":
      return (
        <svg className="pip-bat-svg" viewBox="0 0 26 16" aria-hidden="true">
          <rect className="pip-bat-body" x="1.5" y="2.5" width="19" height="11" rx="2.6" />
          <rect className="pip-bat-nub" x="21.5" y="5.5" width="2.2" height="5" rx="1" />
          <rect className="pip-bat-fill-full" x="3.5" y="4.5" width="15" height="7" rx="1.4" />
          <path className="pip-bat-full-check" d="M 7.8 8.0 L 10.0 10.2 L 14.4 5.8" />
          <path
            className="pip-bat-full-star"
            d="M 21 0 L 21.7 1.8 L 23.5 2.5 L 21.7 3.2 L 21 5 L 20.3 3.2 L 18.5 2.5 L 20.3 1.8 Z"
          />
        </svg>
      );
    default:
      return null;
  }
}

export const PipCommentBubbleWindow: React.FC = () => {
  const [renderedKind, setRenderedKind] = useState<PipBubbleKind | null>(null);
  const [visible, setVisible] = useState(false);
  const [flipRight, setFlipRight] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [batteryPct, setBatteryPct] = useState(100);
  const popRafRef = useRef<number | null>(null);

  useEffect(() => {
    let unlistenSync: (() => void) | undefined;
    let unlistenFlip: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;
    let disposed = false;

    const attach = async () => {
      try {
        unlistenSync = await listen<PipBubbleSyncPayload>("pip-bubble-sync", (event) => {
          if (disposed) return;
          const payload = event.payload || {};
          if (typeof payload.darkMode === "boolean") {
            setDarkMode(payload.darkMode);
          }
          if (typeof payload.flipRight === "boolean") {
            setFlipRight(payload.flipRight);
          }
          if (typeof payload.batteryPct === "number") {
            setBatteryPct(payload.batteryPct);
          }
          if (popRafRef.current !== null) {
            cancelAnimationFrame(popRafRef.current);
            popRafRef.current = null;
          }
          if (payload.kind) {
            setRenderedKind(payload.kind);
            setVisible(false);
            popRafRef.current = requestAnimationFrame(() => {
              popRafRef.current = requestAnimationFrame(() => {
                popRafRef.current = null;
                if (!disposed) setVisible(true);
              });
            });
          } else {
            setVisible(false);
          }
        });

        unlistenFlip = await listen<PipBubbleFlipPayload>("pip-bubble-flip", (event) => {
          if (!disposed && typeof event.payload?.flipRight === "boolean") {
            setFlipRight(event.payload.flipRight);
          }
        });

        unlistenTheme = await listen<ChatPillThemePayload>("chat-pill-sync", (event) => {
          if (!disposed && typeof event.payload?.isDarkMode === "boolean") {
            setDarkMode(event.payload.isDarkMode);
          }
        });
      } catch {
        // Fallback outside Tauri
      }
    };

    attach();

    return () => {
      disposed = true;
      if (popRafRef.current !== null) cancelAnimationFrame(popRafRef.current);
      if (unlistenSync) unlistenSync();
      if (unlistenFlip) unlistenFlip();
      if (unlistenTheme) unlistenTheme();
    };
  }, []);

  const moodClass = renderedKind ? `mood-${renderedKind}` : "";

  return (
    <div className={`pip-bubble-window ${darkMode ? "dark-mode" : "light-mode"}`}>
      <div
        className={`pip-bubble-shell ${visible ? "is-visible" : ""} ${
          flipRight ? "flip-right" : ""
        } ${moodClass}`}
      >
        <div className="pip-bubble-inner">
          <svg className="pip-bubble-bg-svg" viewBox="0 0 60 48" aria-hidden="true">
            <path
              className="pip-bubble-shape"
              d="M 30 3 C 46 3, 57 11, 57 21.5 C 57 30, 50.5 36.5, 42.5 38.8 L 49 46 L 35 39.8 C 33.3 40, 31.7 40, 30 40 C 14 40, 3 32, 3 21.5 C 3 11, 14 3, 30 3 Z"
            />
          </svg>
          <div className="pip-bubble-glyph-box">{renderBubbleGlyph(renderedKind, batteryPct)}</div>
        </div>
      </div>
    </div>
  );
};
