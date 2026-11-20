import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./PipHeadphones.css";

export type PipHeadphonesMode = "off" | "on" | "removing";

interface PipHeadphonesSyncPayload {
  mode?: PipHeadphonesMode;
  darkMode?: boolean;
  playing?: boolean;
  paused?: boolean;
  bpm?: number;
}

interface ChatPillThemePayload {
  isDarkMode?: boolean | null;
}

export const PipHeadphonesWindow: React.FC = () => {
  const [mode, setMode] = useState<PipHeadphonesMode>("off");
  const [darkMode, setDarkMode] = useState(true);

  const modeRef = useRef<PipHeadphonesMode>("off");
  const enterRafRef = useRef<number | null>(null);

  useEffect(() => {
    let unlistenSync: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;
    let disposed = false;

    const attach = async () => {
      try {
        unlistenSync = await listen<PipHeadphonesSyncPayload>("pip-headphones-sync", (event) => {
          if (disposed) return;
          const payload = event.payload || {};
          if (typeof payload.darkMode === "boolean") {
            setDarkMode(payload.darkMode);
          }

          if (payload.mode) {
            if (enterRafRef.current !== null) {
              cancelAnimationFrame(enterRafRef.current);
              enterRafRef.current = null;
            }
            if (payload.mode === "on" && modeRef.current !== "on") {
              modeRef.current = "off";
              setMode("off");
              enterRafRef.current = requestAnimationFrame(() => {
                enterRafRef.current = requestAnimationFrame(() => {
                  enterRafRef.current = null;
                  if (!disposed) {
                    modeRef.current = "on";
                    setMode("on");
                  }
                });
              });
            } else {
              modeRef.current = payload.mode;
              setMode(payload.mode);
            }
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
      if (enterRafRef.current !== null) cancelAnimationFrame(enterRafRef.current);
      if (unlistenSync) unlistenSync();
      if (unlistenTheme) unlistenTheme();
    };
  }, []);

  const rigClasses = [
    "pip-hp-rig",
    mode === "on" ? "hp-on" : "",
    mode === "removing" ? "hp-removing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`pip-headphones-window ${darkMode ? "dark-mode" : "light-mode"}`}>
      <div className={rigClasses}>
        <svg className="pip-hp-svg" viewBox="0 0 108 100" aria-hidden="true">
          <defs>
            <pattern id="pipApmMeshPatternDark" width="3" height="3" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="0.55" fill="rgba(255,255,255,0.13)" />
              <circle cx="2.6" cy="2.6" r="0.45" fill="rgba(0,0,0,0.34)" />
            </pattern>
            <pattern id="pipApmMeshPatternLight" width="3" height="3" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="0.52" fill="rgba(15,23,42,0.12)" />
              <circle cx="2.6" cy="2.6" r="0.45" fill="rgba(255,255,255,0.45)" />
            </pattern>

            {/* Midnight / Space Gray (Dark Mode) */}
            <linearGradient id="pipApmMeshFillMidnight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3c4352" stopOpacity="0.92" />
              <stop offset="100%" stopColor="#1e232e" stopOpacity="0.88" />
            </linearGradient>
            <linearGradient id="pipApmSteelMidnight" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#64748b" />
              <stop offset="40%" stopColor="#e2e8f0" />
              <stop offset="72%" stopColor="#94a3b8" />
              <stop offset="100%" stopColor="#475569" />
            </linearGradient>
            <linearGradient id="pipApmAlumMidnightL" x1="0" y1="0.15" x2="1" y2="0.85">
              <stop offset="0%" stopColor="#5b6474" />
              <stop offset="35%" stopColor="#3d4452" />
              <stop offset="80%" stopColor="#262b35" />
              <stop offset="100%" stopColor="#1c2029" />
            </linearGradient>
            <linearGradient id="pipApmAlumMidnightR" x1="1" y1="0.15" x2="0" y2="0.85">
              <stop offset="0%" stopColor="#5b6474" />
              <stop offset="35%" stopColor="#3d4452" />
              <stop offset="80%" stopColor="#262b35" />
              <stop offset="100%" stopColor="#1c2029" />
            </linearGradient>
            <linearGradient id="pipApmCushionMidnightL" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#1a1e26" />
              <stop offset="52%" stopColor="#2c323e" />
              <stop offset="100%" stopColor="#171a21" />
            </linearGradient>
            <linearGradient id="pipApmCushionMidnightR" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#1a1e26" />
              <stop offset="52%" stopColor="#2c323e" />
              <stop offset="100%" stopColor="#171a21" />
            </linearGradient>

            {/* Silver (Light Mode) */}
            <linearGradient id="pipApmMeshFillSilver" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f1f5f9" stopOpacity="0.94" />
              <stop offset="100%" stopColor="#cbd5e1" stopOpacity="0.9" />
            </linearGradient>
            <linearGradient id="pipApmSteelSilver" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#94a3b8" />
              <stop offset="42%" stopColor="#ffffff" />
              <stop offset="75%" stopColor="#cbd5e1" />
              <stop offset="100%" stopColor="#64748b" />
            </linearGradient>
            <linearGradient id="pipApmAlumSilverL" x1="0" y1="0.1" x2="1" y2="0.9">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#e2e8f0" />
              <stop offset="85%" stopColor="#cbd5e1" />
              <stop offset="100%" stopColor="#b0bccd" />
            </linearGradient>
            <linearGradient id="pipApmAlumSilverR" x1="1" y1="0.1" x2="0" y2="0.9">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#e2e8f0" />
              <stop offset="85%" stopColor="#cbd5e1" />
              <stop offset="100%" stopColor="#b0bccd" />
            </linearGradient>
            <linearGradient id="pipApmCushionSilverL" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#cbd5e1" />
              <stop offset="52%" stopColor="#e8edf4" />
              <stop offset="100%" stopColor="#b8c3d3" />
            </linearGradient>
            <linearGradient id="pipApmCushionSilverR" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#cbd5e1" />
              <stop offset="52%" stopColor="#e8edf4" />
              <stop offset="100%" stopColor="#b8c3d3" />
            </linearGradient>
          </defs>

          <g className="pip-apm-whole">
            {/* Breathable knit mesh canopy cleanly above cube crown */}
            <path
              className="pip-apm-canopy-base"
              d="M 25 20.5 C 33 10.2, 43 7.5, 54 7.5 C 65 7.5, 75 10.2, 83 20.5 Q 54 16.2 25 20.5 Z"
              strokeWidth="0.6"
            />
            <path
              className="pip-apm-canopy-weave"
              d="M 25 20.5 C 33 10.2, 43 7.5, 54 7.5 C 65 7.5, 75 10.2, 83 20.5 Q 54 16.2 25 20.5 Z"
            />

            {/* Outer steel frame arch clearing top corners with zero clipping */}
            <path
              className="pip-apm-band-outer"
              d="M 12.6 41 C 12.6 14.5, 27 6.5, 54 6.5 C 81 6.5, 95.4 14.5, 95.4 41"
              fill="none"
              strokeWidth="4.8"
              strokeLinecap="round"
            />
            <path
              className="pip-apm-band-sheen"
              d="M 16.5 31 C 19 14.5, 31 8.1, 54 8.1 C 77 8.1, 89 14.5, 91.5 31"
              fill="none"
              strokeWidth="1.2"
              strokeLinecap="round"
            />

            {/* Headband arm collars */}
            <rect className="pip-apm-collar" x="10.2" y="37.2" width="4.8" height="4.8" rx="1.6" strokeWidth="0.6" />
            <rect className="pip-apm-collar" x="93.0" y="37.2" width="4.8" height="4.8" rx="1.6" strokeWidth="0.6" />

            {/* Left Earcup Assembly (cushion flush at x=19.8, zero overlap into cube) */}
            <g className="pip-apm-cup-l">
              <rect className="pip-apm-stem" x="11.3" y="41.2" width="2.6" height="7.4" rx="1.1" />
              <rect className="pip-apm-cushion-l" x="13.8" y="46.2" width="6.0" height="29.0" rx="3.0" strokeWidth="0.7" />
              <rect className="pip-apm-cup-shell-l" x="5.4" y="47.2" width="9.4" height="27.0" rx="4.7" strokeWidth="0.85" />
              <path
                d="M 7.8 51.6 C 6.9 56.5, 6.9 64.5, 7.8 69.8"
                fill="none"
                stroke="rgba(255,255,255,0.22)"
                strokeWidth="1.15"
                strokeLinecap="round"
              />
            </g>

            {/* Right Earcup Assembly (mirror + signature Digital Crown nub) */}
            <g className="pip-apm-cup-r">
              <rect className="pip-apm-stem" x="94.1" y="41.2" width="2.6" height="7.4" rx="1.1" />
              <rect className="pip-apm-crown" x="97.4" y="45.6" width="3.0" height="2.4" rx="0.9" strokeWidth="0.55" />
              <rect className="pip-apm-cushion-r" x="88.2" y="46.2" width="6.0" height="29.0" rx="3.0" strokeWidth="0.7" />
              <rect className="pip-apm-cup-shell-r" x="93.2" y="47.2" width="9.4" height="27.0" rx="4.7" strokeWidth="0.85" />
              <path
                d="M 100.2 51.6 C 101.1 56.5, 101.1 64.5, 100.2 69.8"
                fill="none"
                stroke="rgba(255,255,255,0.22)"
                strokeWidth="1.15"
                strokeLinecap="round"
              />
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
};
