import React, { useState, useRef, useEffect, useCallback } from "react";

export interface SystemSliderProps {
  type: "volume" | "brightness";
  level: number;
  muted?: boolean;
  onHardwareChange?: (action: "volume" | "brightness", level?: number, muted?: boolean) => void;
}

export const SystemSlider: React.FC<SystemSliderProps> = ({
  type,
  level = 0,
  muted = false,
  onHardwareChange,
}) => {
  const [currentLevel, setCurrentLevel] = useState<number>(Math.round(level));
  const [isMuted, setIsMuted] = useState<boolean>(Boolean(muted));
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const isDraggingRef = useRef<boolean>(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const lastSentTimeRef = useRef<number>(0);
  const pendingThrottleTimerRef = useRef<number | null>(null);

  // Sync state when props change (unless user is actively dragging)
  useEffect(() => {
    if (!isDraggingRef.current) {
      setCurrentLevel(Math.round(level));
      setIsMuted(Boolean(muted));
    }
  }, [level, muted]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (pendingThrottleTimerRef.current !== null) {
        window.clearTimeout(pendingThrottleTimerRef.current);
      }
    };
  }, []);

  // Send hardware change (throttled to ~60ms for smooth 0-latency physical response)
  const dispatchHardwareChange = useCallback(
    (actionType: "volume" | "brightness", newLevel?: number, newMuted?: boolean) => {
      if (!onHardwareChange) return;

      const now = Date.now();
      const timeSinceLast = now - lastSentTimeRef.current;

      if (timeSinceLast >= 60) {
        lastSentTimeRef.current = now;
        onHardwareChange(actionType, newLevel, newMuted);
      } else {
        if (pendingThrottleTimerRef.current !== null) {
          window.clearTimeout(pendingThrottleTimerRef.current);
        }
        pendingThrottleTimerRef.current = window.setTimeout(() => {
          lastSentTimeRef.current = Date.now();
          onHardwareChange(actionType, newLevel, newMuted);
        }, 60 - timeSinceLast);
      }
    },
    [onHardwareChange]
  );

  // Calculate percentage from clientX
  const updateFromClientX = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      let pct = Math.round(((clientX - rect.left) / rect.width) * 100);
      pct = Math.max(0, Math.min(100, pct));

      setCurrentLevel(pct);
      if (isMuted) {
        setIsMuted(false);
      }

      dispatchHardwareChange(type, pct, undefined);
    },
    [dispatchHardwareChange, isMuted, type]
  );

  // Mouse / Touch interaction handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    updateFromClientX(e.clientX);

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (isDraggingRef.current) {
        updateFromClientX(moveEvent.clientX);
      }
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      isDraggingRef.current = false;
      setIsDragging(false);
      updateFromClientX(upEvent.clientX);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!e.touches[0]) return;
    isDraggingRef.current = true;
    setIsDragging(true);
    updateFromClientX(e.touches[0].clientX);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || !e.touches[0]) return;
    updateFromClientX(e.touches[0].clientX);
  };

  const handleTouchEnd = () => {
    isDraggingRef.current = false;
    setIsDragging(false);
  };

  // Toggle Mute (Volume only)
  const handleToggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (type !== "volume") return;

    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    dispatchHardwareChange("volume", undefined, nextMuted);
  };

  const effectivePct = isMuted ? 0 : currentLevel;

  return (
    <div className="siri-win-slider-pill">
      {/* Leading Icon */}
      <button
        type="button"
        className={`win-slider-icon-btn ${isMuted ? "muted" : ""}`}
        onClick={type === "volume" ? handleToggleMute : undefined}
        title={type === "volume" ? (isMuted ? "Click to unmute" : "Click to mute") : "Display Brightness"}
      >
        {type === "volume" ? (
          isMuted ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            </svg>
          ) : effectivePct === 0 ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            </svg>
          ) : effectivePct < 50 ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          ) : (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          )
        ) : (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        )}
      </button>

      {/* Center Track */}
      <div
        ref={trackRef}
        className={`win-slider-track ${isDragging ? "dragging" : ""}`}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="win-slider-rail" />
        <div
          className={`win-slider-fill ${isMuted ? "muted" : ""}`}
          style={{ width: `${effectivePct}%` }}
        />
        <div
          className="win-slider-thumb"
          style={{ left: `${effectivePct}%` }}
        />
      </div>

      {/* Trailing Value */}
      <div className="win-slider-value">
        {isMuted ? "0" : currentLevel}
      </div>
    </div>
  );
};

