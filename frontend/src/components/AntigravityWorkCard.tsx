import React, { useState, useRef, useEffect } from "react";
import "./AntigravityWorkCard.css";

export interface AgyWorkStep {
  text: string;
  status: "active" | "done";
}

export interface AgyWorkJobState {
  jobId: string;
  task: string;
  workingDir?: string;
  status: "running" | "completed" | "failed";
  steps: AgyWorkStep[];
  elapsedSec: number;
  summary?: string;
  cardDismissed: boolean;
  anchorTurnId: string | null;
}

interface AntigravityWorkCardProps {
  job: AgyWorkJobState;
  onDismiss: (jobId: string) => void;
  onStop: (jobId: string) => void;
}

function formatElapsed(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export const AntigravityWorkCard: React.FC<AntigravityWorkCardProps> = ({
  job,
  onDismiss,
  onStop,
}) => {
  const [isDismissing, setIsDismissing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setIsDismissing(false);
    setIsStopping(false);
  }, [job.jobId]);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  const handleMinimizeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDismissing || job.status !== "running") return;
    setIsDismissing(true);
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      onDismiss(job.jobId);
    }, 290);
  };

  const handleStopClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStopping || isDismissing || job.status !== "running") return;
    setIsStopping(true);
    onStop(job.jobId);
  };

  const visibleSteps = (job.steps || []).slice(-4);
  const isRunning = job.status === "running";
  const isCompleted = job.status === "completed";
  const isFailed = job.status === "failed";

  const statusTitle = isRunning
    ? isStopping
      ? "Stopping"
      : "Working"
    : isCompleted
    ? "Completed"
    : "Stopped";

  return (
    <div
      className={`agy-inline-card-shell ${isDismissing ? "is-dismissing" : ""}`}
      aria-live="polite"
    >
      <div
        className={`agy-inline-card status-${job.status} ${
          isDismissing ? "is-dismissing" : ""
        }`}
      >
        <div className="agy-inline-header">
          <div className="agy-inline-left">
            <img
              src="/icons/antigravity.png"
              alt="Antigravity"
              className="agy-inline-brand-icon"
            />
            {isRunning ? (
              <svg
                className="agy-inline-gear-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            ) : isCompleted ? (
              <svg
                className="agy-inline-done-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg
                className="agy-inline-fail-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="8" x2="12" y2="12.5" />
                <circle cx="12" cy="16" r="0.8" fill="currentColor" />
              </svg>
            )}
            <span className="agy-inline-title">{statusTitle}</span>
          </div>

          <div className="agy-inline-right">
            <span className="agy-inline-timer">{formatElapsed(job.elapsedSec)}</span>

            {isRunning && (
              <>
                <button
                  type="button"
                  className="agy-inline-stop-btn"
                  onClick={handleStopClick}
                  disabled={isStopping || isDismissing}
                  title="Stop Antigravity task"
                  aria-label="Stop Antigravity task"
                >
                  <span className="agy-inline-stop-sq" aria-hidden="true" />
                  <span>{isStopping ? "Stopping" : "Stop"}</span>
                </button>

                <button
                  type="button"
                  className="agy-inline-min-btn"
                  onClick={handleMinimizeClick}
                  disabled={isDismissing}
                  title="Minimize card & continue chatting in background"
                  aria-label="Minimize Antigravity task card"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                  >
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>

        {visibleSteps.length > 0 && (
          <div className="agy-inline-steps">
            {visibleSteps.map((step, idx) => {
              const isActive = isRunning && step.status === "active";
              return (
                <div
                  key={`${idx}-${step.text}`}
                  className={`agy-inline-step ${isActive ? "is-active" : "is-done"} ${
                    isFailed && idx === visibleSteps.length - 1 ? "is-error" : ""
                  }`}
                >
                  <span className="agy-inline-dot" aria-hidden="true" />
                  <span className="agy-inline-step-text">{step.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
