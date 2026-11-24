import React, { useEffect, useRef, useCallback, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { PipBubbleKind } from "./PipCommentBubble";

interface PipSquareEyesProps {
  active: boolean;
  isAwake?: boolean;
  isStreaming?: boolean;
  isDarkMode?: boolean;
  isAntigravityWorking?: boolean;
  antigravityDoneSeq?: number;
  antigravityFailedSeq?: number;
  onMaximize: () => void;
  onDragVisualChange: (dragging: boolean, dimmed: boolean) => void;
  onRimToneChange?: (tone: "none" | "green" | "red" | "amber" | "music" | "work_green") => void;
}

interface EyeShape {
  outer: number;
  mid: number;
  inner: number;
  sx: number;
  sy: number;
  dy: number;
}

interface ExprPreset {
  name: string;
  L: EyeShape;
  R: EyeShape;
  tilt: number;
  op: number;
}

interface GazeStep {
  x: number;
  y: number;
  speed?: number;
  wait: number;
}

interface DragState {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  prevScreenX: number;
  prevScreenY: number;
  prevTime: number;
  prevVx: number;
  prevVy: number;
  moved: boolean;
  peakDizzy: number;
  pendingStep: boolean;
  queuedStep: boolean;
}

interface BlinkState {
  start: number;
  duration: number;
  allowDouble: boolean;
  forceDouble: boolean;
  eyes: "both" | "L" | "R";
}

interface ActiveEventState {
  type:
    | "blink"
    | "wink"
    | "wiggle_L"
    | "wiggle_R"
    | "surprised"
    | "happy"
    | "annoyed"
    | "shy"
    | "focused"
    | "micronod_droop"
    | "sneeze_build"
    | "sneeze_pop"
    | "plug_wriggle"
    | "tired_low"
    | "excited_music";
  endsAt: number;
}

const ENTER_RADIUS = 428;
const EXIT_RADIUS = 480;
const REACH_DIST = 145;
const MAX_GAZE_X = 10.8;
const MAX_GAZE_Y = 6.2;

// Top-only eyelid ("eyebrow") shape presets in 28x48 viewBox space.
// y=0 is top pill edge, y=48 is bottom edge; negative y arches above top rim.
const EXPR_PRESETS: Record<string, ExprPreset> = {
  neutral: {
    name: "neutral",
    L: { outer: -3, mid: -4, inner: -3, sx: 1, sy: 1, dy: 0 },
    R: { outer: -3, mid: -4, inner: -3, sx: 1, sy: 1, dy: 0 },
    tilt: 0,
    op: 1.0,
  },
  curious: {
    name: "curious",
    L: { outer: -3, mid: -5, inner: -3, sx: 1.03, sy: 1.09, dy: -1.2 },
    R: { outer: 18, mid: 19, inner: 23, sx: 1.05, sy: 0.92, dy: 0.8 },
    tilt: -4.6,
    op: 1.0,
  },
  focused: {
    name: "focused",
    L: { outer: 4, mid: 11, inner: 21, sx: 1.04, sy: 0.98, dy: 0.3 },
    R: { outer: 4, mid: 11, inner: 21, sx: 1.04, sy: 0.98, dy: 0.3 },
    tilt: 0,
    op: 1.0,
  },
  working_agy: {
    name: "working_agy",
    L: { outer: 6, mid: 13, inner: 22, sx: 1.05, sy: 0.94, dy: 0.4 },
    R: { outer: 6, mid: 13, inner: 22, sx: 1.05, sy: 0.94, dy: 0.4 },
    tilt: -1.8,
    op: 1.0,
  },
  annoyed: {
    name: "annoyed",
    L: { outer: 2, mid: 16, inner: 32, sx: 1.08, sy: 0.9, dy: 0.9 },
    R: { outer: 2, mid: 16, inner: 32, sx: 1.08, sy: 0.9, dy: 0.9 },
    tilt: -2.2,
    op: 0.95,
  },
  shy: {
    name: "shy",
    L: { outer: 25, mid: 12, inner: 2, sx: 1.03, sy: 0.95, dy: 0.6 },
    R: { outer: 25, mid: 12, inner: 2, sx: 1.03, sy: 0.95, dy: 0.6 },
    tilt: 3.2,
    op: 0.92,
  },
  chill: {
    name: "chill",
    L: { outer: 17, mid: 18, inner: 17, sx: 1.04, sy: 0.98, dy: 0.4 },
    R: { outer: 17, mid: 18, inner: 17, sx: 1.04, sy: 0.98, dy: 0.4 },
    tilt: 0,
    op: 0.88,
  },
  happy: {
    name: "happy",
    L: { outer: 13, mid: -7, inner: 13, sx: 1.2, sy: 0.48, dy: 0.6 },
    R: { outer: 13, mid: -7, inner: 13, sx: 1.2, sy: 0.48, dy: 0.6 },
    tilt: 0,
    op: 1.0,
  },
  sleepy: {
    name: "sleepy",
    L: { outer: 27, mid: 29, inner: 27, sx: 1.05, sy: 0.94, dy: 1.2 },
    R: { outer: 27, mid: 29, inner: 27, sx: 1.05, sy: 0.94, dy: 1.2 },
    tilt: -1.2,
    op: 0.8,
  },
  tired_low: {
    name: "tired_low",
    L: { outer: 28, mid: 18, inner: 11, sx: 1.03, sy: 0.86, dy: 1.6 },
    R: { outer: 28, mid: 18, inner: 11, sx: 1.03, sy: 0.86, dy: 1.6 },
    tilt: 3.4,
    op: 0.84,
  },
  surprised: {
    name: "surprised",
    L: { outer: -4, mid: -5, inner: -4, sx: 1.08, sy: 1.17, dy: -1.0 },
    R: { outer: -4, mid: -5, inner: -4, sx: 1.08, sy: 1.17, dy: -1.0 },
    tilt: 0,
    op: 1.0,
  },
  excited_music: {
    name: "excited_music",
    L: { outer: -4, mid: -6, inner: -4, sx: 1.09, sy: 1.18, dy: -1.3 },
    R: { outer: -4, mid: -6, inner: -4, sx: 1.09, sy: 1.18, dy: -1.3 },
    tilt: 0,
    op: 1.0,
  },
  vibing_bliss: {
    name: "vibing_bliss",
    L: { outer: 18, mid: 2, inner: 18, sx: 1.16, sy: 0.66, dy: 0.4 },
    R: { outer: 18, mid: 2, inner: 18, sx: 1.16, sy: 0.66, dy: 0.4 },
    tilt: 0,
    op: 1.0,
  },
  vibing_cool: {
    name: "vibing_cool",
    L: { outer: 19, mid: 17, inner: 20, sx: 1.08, sy: 0.86, dy: 0.7 },
    R: { outer: 19, mid: 17, inner: 20, sx: 1.08, sy: 0.86, dy: 0.7 },
    tilt: 0,
    op: 0.97,
  },
  bored_pause: {
    name: "bored_pause",
    L: { outer: 24, mid: 25, inner: 24, sx: 1.04, sy: 0.9, dy: 1.5 },
    R: { outer: 24, mid: 25, inner: 24, sx: 1.04, sy: 0.9, dy: 1.5 },
    tilt: 2.2,
    op: 0.86,
  },
};

const VIBE_BUBBLE_CYCLE: PipBubbleKind[] = ["music_eq", "music_notes", "music_vinyl", "music_vibe"];
const SPOTIFY_PAUSE_STOW_MS = 6500;
const SPOTIFY_GROOVE_BPM = 112;

const SPOT_PRESETS: Array<{ fx: number; fy: number }> = [
  { fx: -0.9, fy: -0.1 },
  { fx: 0.9, fy: -0.1 },
  { fx: 0, fy: -0.92 },
  { fx: -0.78, fy: -0.78 },
  { fx: 0.78, fy: -0.78 },
  { fx: -0.72, fy: 0.74 },
  { fx: 0.72, fy: 0.74 },
  { fx: 0, fy: 0 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function buildEyePath(outerY: number, midY: number, innerY: number, isRight: boolean): string {
  const yL = isRight ? innerY : outerY;
  const yR = isRight ? outerY : innerY;
  const qCtrlY = 2 * midY - 0.5 * (yL + yR);
  return `M -4,${yL.toFixed(1)} Q 14,${qCtrlY.toFixed(1)} 32,${yR.toFixed(1)} L 32,54 L -4,54 Z`;
}

function pickRandomSpot(): { x: number; y: number } {
  const pick = SPOT_PRESETS[Math.floor(Math.random() * SPOT_PRESETS.length)];
  const jx = (Math.random() - 0.5) * 2.1;
  const jy = (Math.random() - 0.5) * 1.4;
  return {
    x: Math.max(-MAX_GAZE_X, Math.min(MAX_GAZE_X, MAX_GAZE_X * pick.fx + jx)),
    y: Math.max(-MAX_GAZE_Y, Math.min(MAX_GAZE_Y, MAX_GAZE_Y * pick.fy + jy)),
  };
}

function cloneShape(shape: EyeShape): EyeShape {
  return { ...shape };
}

/**
 * Pure-glass 68x68 living eyes with top-only curved eyebrow eyelids, head tilt,
 * idle doze + micro-nods, cursor hover/headpat/startle, streaming focus scan,
 * drag inertia, landing bounce, and dizzy post-shake glare.
 */
export const PipSquareEyes: React.FC<PipSquareEyesProps> = ({
  active,
  isAwake = false,
  isStreaming = false,
  isDarkMode = true,
  isAntigravityWorking = false,
  antigravityDoneSeq = 0,
  antigravityFailedSeq = 0,
  onMaximize,
  onDragVisualChange,
  onRimToneChange,
}) => {
  const [showSparkle, setShowSparkle] = useState(false);

  const eyesRef = useRef<HTMLDivElement>(null);
  const leftSlotRef = useRef<HTMLDivElement>(null);
  const rightSlotRef = useRef<HTMLDivElement>(null);
  const leftPathRef = useRef<SVGPathElement>(null);
  const rightPathRef = useRef<SVGPathElement>(null);

  const activeRef = useRef(active);
  activeRef.current = active;
  const isAwakeRef = useRef(isAwake);
  isAwakeRef.current = isAwake;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const isDarkModeRef = useRef(isDarkMode);
  isDarkModeRef.current = isDarkMode;
  const isAntigravityWorkingRef = useRef(isAntigravityWorking);
  isAntigravityWorkingRef.current = isAntigravityWorking;
  const onMaximizeRef = useRef(onMaximize);
  onMaximizeRef.current = onMaximize;
  const onDragVisualChangeRef = useRef(onDragVisualChange);
  onDragVisualChangeRef.current = onDragVisualChange;
  const onRimToneChangeRef = useRef(onRimToneChange);
  onRimToneChangeRef.current = onRimToneChange;

  const animRef = useRef({
    gx: 0,
    gy: 0,
    targetGx: 0,
    targetGy: 0,
    gazeLerp: 12,
    tilt: 0,
    targetTilt: 0,
    op: 1,
    bounceSx: 1,
    bounceSy: 1,
    bounceY: 0,
    L: cloneShape(EXPR_PRESETS.neutral.L),
    R: cloneShape(EXPR_PRESETS.neutral.R),
    winkHoldR: 0,
    lastInteractionTime: performance.now(),
    dizzyLevel: 0,
    dizzyPhase: 0,
    isHovered: false,
    isNear: false,
    cursorDist: 9999,
    cursorDx: 0,
    idleStage: "alert" as "alert" | "relaxed" | "drowsy",
    activeEvent: null as ActiveEventState | null,
    activeBubble: null as { kind: PipBubbleKind; expiresAt: number } | null,
    curiousCooldownUntil: 0,
    drowsyBubbleCooldownUntil: 0,
    activeBlink: null as BlinkState | null,
    scanQueue: [] as GazeStep[],
    streamSweepStep: 0,
    agyWorkSweepStep: 0,
    hasBattery: false,
    pluggedIn: true,
    batteryPct: 100,
    wriggleStart: 0,
    wriggleDuration: 0,
    spotifyRunning: false,
    musicState: "stopped" as "stopped" | "playing" | "paused",
    headphonesState: "off" as "off" | "on" | "removing",
    vibeSubmood: "vibing_bliss" as "vibing_bliss" | "vibing_cool",
    beatStart: performance.now(),
    liveBpm: SPOTIFY_GROOVE_BPM,
    liveBeatCount: 0,
    liveBeatSyncedAt: performance.now(),
    liveSway: "head_nod" as "head_nod" | "beat_hop",
    vibeCycleIdx: 0,
  });

  const lastSentBubbleRef = useRef<PipBubbleKind | null>(null);
  const lastSentBatteryPctRef = useRef<number | null>(null);
  const lowWarnedRef = useRef(false);
  const persistentRimRef = useRef<"none" | "music" | "amber" | "work_green">("none");
  const lastHandledAgyDoneSeqRef = useRef<number>(antigravityDoneSeq);
  const lastHandledAgyFailedSeqRef = useRef<number>(antigravityFailedSeq);

  const syncHeadphonesIpc = useCallback(
    (mode: "off" | "on" | "removing", playing: boolean, paused: boolean) => {
      invoke("set_pip_headphones", {
        mode,
        darkMode: isDarkModeRef.current,
        playing,
        paused,
        bpm: animRef.current.liveBpm,
      }).catch(() => {});
    },
    []
  );

  const syncMusicBopIpc = useCallback((bopActive: boolean, trackReset = false) => {
    invoke("set_pip_music_bop", {
      active: bopActive,
      trackReset,
    }).catch(() => {});
  }, []);

  const syncBubbleIpc = useCallback((nextKind: PipBubbleKind | null) => {
    const pct = animRef.current.batteryPct;
    const isBatKind =
      nextKind === "bat_plug" ||
      nextKind === "bat_unplug" ||
      nextKind === "bat_low" ||
      nextKind === "bat_full";
    if (
      nextKind === lastSentBubbleRef.current &&
      (!isBatKind || pct === lastSentBatteryPctRef.current)
    ) {
      return;
    }
    lastSentBubbleRef.current = nextKind;
    lastSentBatteryPctRef.current = isBatKind ? pct : null;
    invoke("set_pip_bubble", {
      kind: nextKind,
      darkMode: isDarkModeRef.current,
      batteryPct: pct,
    }).catch(() => {});
  }, []);

  const popBubble = useCallback((kind: PipBubbleKind, baseDurationMs: number) => {
    const durationMs = Math.round(baseDurationMs * 2.5);
    animRef.current.activeBubble = {
      kind,
      expiresAt: performance.now() + durationMs,
    };
  }, []);

  const lastDomRef = useRef({
    eyesTf: "",
    slotLTf: "",
    slotRTf: "",
    pathL: "",
    pathR: "",
    op: "",
  });

  const prevStepVecRef = useRef({ dx: 0, dy: 0 });
  const prevCursorRef = useRef({ dx: 0, dy: 0, t: 0, valid: false });
  const headpatRef = useRef({ crossings: 0, lastSign: 0, lastTime: 0 });
  const dragStateRef = useRef<DragState | null>(null);
  const prevStreamingRef = useRef(isStreaming);

  const rafRef = useRef<number | null>(null);
  const prevFrameRef = useRef<number>(0);
  const blinkTimerRef = useRef<number | null>(null);
  const gazeTimerRef = useRef<number | null>(null);
  const streamTimerRef = useRef<number | null>(null);
  const agyWorkTimerRef = useRef<number | null>(null);
  const rareTimerRef = useRef<number | null>(null);
  const sparkleTimerRef = useRef<number | null>(null);
  const rimTimerRef = useRef<number | null>(null);
  const batteryStepTimerRef = useRef<number | null>(null);
  const musicStepTimerRef = useRef<number | null>(null);
  const pauseStowTimerRef = useRef<number | null>(null);
  const hpRemoveFinishTimerRef = useRef<number | null>(null);
  const vibeBubbleTimerRef = useRef<number | null>(null);
  const vibeSubmoodTimerRef = useRef<number | null>(null);
  const boredGlanceTimerRef = useRef<number | null>(null);
  const transientTimersRef = useRef<Set<number>>(new Set());

  const clearMusicTimers = useCallback(() => {
    if (musicStepTimerRef.current !== null) {
      window.clearTimeout(musicStepTimerRef.current);
      musicStepTimerRef.current = null;
    }
    if (pauseStowTimerRef.current !== null) {
      window.clearTimeout(pauseStowTimerRef.current);
      pauseStowTimerRef.current = null;
    }
    if (hpRemoveFinishTimerRef.current !== null) {
      window.clearTimeout(hpRemoveFinishTimerRef.current);
      hpRemoveFinishTimerRef.current = null;
    }
    if (vibeBubbleTimerRef.current !== null) {
      window.clearTimeout(vibeBubbleTimerRef.current);
      vibeBubbleTimerRef.current = null;
    }
    if (vibeSubmoodTimerRef.current !== null) {
      window.clearTimeout(vibeSubmoodTimerRef.current);
      vibeSubmoodTimerRef.current = null;
    }
    if (boredGlanceTimerRef.current !== null) {
      window.clearTimeout(boredGlanceTimerRef.current);
      boredGlanceTimerRef.current = null;
    }
  }, []);

  const scheduleTransient = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      transientTimersRef.current.delete(id);
      if (activeRef.current) {
        fn();
      }
    }, ms);
    transientTimersRef.current.add(id);
    return id;
  }, []);

  const clearAllTimers = useCallback(() => {
    if (blinkTimerRef.current !== null) {
      window.clearTimeout(blinkTimerRef.current);
      blinkTimerRef.current = null;
    }
    if (gazeTimerRef.current !== null) {
      window.clearTimeout(gazeTimerRef.current);
      gazeTimerRef.current = null;
    }
    if (streamTimerRef.current !== null) {
      window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    if (agyWorkTimerRef.current !== null) {
      window.clearTimeout(agyWorkTimerRef.current);
      agyWorkTimerRef.current = null;
    }
    if (rareTimerRef.current !== null) {
      window.clearTimeout(rareTimerRef.current);
      rareTimerRef.current = null;
    }
    if (sparkleTimerRef.current !== null) {
      window.clearTimeout(sparkleTimerRef.current);
      sparkleTimerRef.current = null;
    }
    if (rimTimerRef.current !== null) {
      window.clearTimeout(rimTimerRef.current);
      rimTimerRef.current = null;
    }
    if (batteryStepTimerRef.current !== null) {
      window.clearTimeout(batteryStepTimerRef.current);
      batteryStepTimerRef.current = null;
    }
    clearMusicTimers();
    transientTimersRef.current.forEach((id) => window.clearTimeout(id));
    transientTimersRef.current.clear();
  }, [clearMusicTimers]);

  const flashSparkle = useCallback((durationMs: number) => {
    if (sparkleTimerRef.current !== null) {
      window.clearTimeout(sparkleTimerRef.current);
    }
    setShowSparkle(true);
    sparkleTimerRef.current = window.setTimeout(() => {
      sparkleTimerRef.current = null;
      setShowSparkle(false);
    }, durationMs);
  }, []);

  const setPersistentRim = useCallback((tone: "none" | "music" | "amber" | "work_green") => {
    const resolved =
      tone === "none" && isAntigravityWorkingRef.current ? "work_green" : tone;
    persistentRimRef.current = resolved;
    if (rimTimerRef.current === null) {
      onRimToneChangeRef.current?.(resolved);
    }
  }, []);

  const flashRim = useCallback((tone: "green" | "red", durationMs: number) => {
    if (rimTimerRef.current !== null) {
      window.clearTimeout(rimTimerRef.current);
    }
    onRimToneChangeRef.current?.(tone);
    rimTimerRef.current = window.setTimeout(() => {
      rimTimerRef.current = null;
      onRimToneChangeRef.current?.(persistentRimRef.current);
    }, durationMs);
  }, []);

  const setActiveEvent = useCallback((type: ActiveEventState["type"], durationMs: number) => {
    animRef.current.activeEvent = { type, endsAt: performance.now() + durationMs };
  }, []);

  const triggerBlink = useCallback(
    (durationMs = 165, allowDouble = false, forceDouble = false, eyes: "both" | "L" | "R" = "both") => {
      if (!activeRef.current) return;
      const st = animRef.current;
      if (st.activeBlink && !forceDouble) return;
      st.activeBlink = {
        start: performance.now(),
        duration: durationMs,
        allowDouble,
        forceDouble,
        eyes,
      };
    },
    []
  );

  const scheduleNextBlink = useCallback(() => {
    if (blinkTimerRef.current !== null) {
      window.clearTimeout(blinkTimerRef.current);
      blinkTimerRef.current = null;
    }
    if (!activeRef.current) return;
    const st = animRef.current;
    const isLowPower =
      st.activeEvent?.type === "tired_low" ||
      (st.hasBattery && !st.pluggedIn && st.batteryPct <= 20);
    const isBoredPause = st.musicState === "paused" && st.headphonesState === "on";
    const isDrowsy = st.idleStage === "drowsy" && !isAwakeRef.current && !isStreamingRef.current;
    const delay =
      isDrowsy || isLowPower || isBoredPause
        ? 3200 + Math.random() * 2600
        : 2100 + Math.random() * 3400;
    blinkTimerRef.current = window.setTimeout(() => {
      blinkTimerRef.current = null;
      if (!activeRef.current) return;
      const cur = animRef.current;
      if (cur.dizzyLevel < 0.08 && !dragStateRef.current?.moved && cur.activeEvent?.type !== "happy") {
        const drowsyNow = cur.idleStage === "drowsy" && !isAwakeRef.current && !isStreamingRef.current;
        const lowNow =
          cur.activeEvent?.type === "tired_low" ||
          (cur.hasBattery && !cur.pluggedIn && cur.batteryPct <= 20);
        const boredNow = cur.musicState === "paused" && cur.headphonesState === "on";
        triggerBlink(
          drowsyNow || lowNow || boredNow
            ? 280 + Math.round(Math.random() * 80)
            : 155 + Math.round(Math.random() * 30),
          !drowsyNow && !lowNow && !boredNow,
          false,
          "both"
        );
      }
      scheduleNextBlink();
    }, delay);
  }, [triggerBlink]);

  const setGazeGoal = useCallback(
    (nx: number, ny: number, speed = 13, allowSaccadeBlink = true) => {
      const st = animRef.current;
      const cx = Math.max(-MAX_GAZE_X, Math.min(MAX_GAZE_X, nx));
      const cy = Math.max(-MAX_GAZE_Y, Math.min(MAX_GAZE_Y, ny));
      const dx = cx - st.targetGx;
      const dy = cy - st.targetGy;
      const dist = Math.hypot(dx, dy);
      const normDist = dist / (MAX_GAZE_X * 1.45);
      const prevMag = Math.hypot(prevStepVecRef.current.dx, prevStepVecRef.current.dy);
      let isSharpReversal = false;
      if (prevMag > 1.5 && dist > 1.5) {
        const dot = (prevStepVecRef.current.dx * dx + prevStepVecRef.current.dy * dy) / (prevMag * dist);
        isSharpReversal = dot <= -0.35;
      }
      if (allowSaccadeBlink && speed >= 11 && !st.activeEvent) {
        if (
          normDist >= 0.72 ||
          (isSharpReversal && normDist >= 0.56) ||
          (normDist >= 0.48 && Math.random() < 0.55)
        ) {
          scheduleTransient(() => triggerBlink(150, false, false), 14);
        }
      }
      prevStepVecRef.current = { dx, dy };
      st.targetGx = cx;
      st.targetGy = cy;
      st.gazeLerp = speed;
    },
    [scheduleTransient, triggerBlink]
  );

  const scheduleNextGaze = useCallback(() => {
    if (gazeTimerRef.current !== null) {
      window.clearTimeout(gazeTimerRef.current);
      gazeTimerRef.current = null;
    }
    if (!activeRef.current) return;
    const st = animRef.current;
    if (
      isStreamingRef.current ||
      isAntigravityWorkingRef.current ||
      st.isNear ||
      dragStateRef.current?.moved ||
      st.dizzyLevel > 0.05
    ) {
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 500);
      return;
    }

    if (st.scanQueue.length > 0) {
      const step = st.scanQueue.shift()!;
      setGazeGoal(step.x, step.y, step.speed ?? 13);
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, step.wait);
      return;
    }

    // Paused chat glances upward periodically as if holding context
    if (isAwakeRef.current && Math.random() < 0.35) {
      const side = Math.random() < 0.5 ? -0.65 : 0.65;
      setGazeGoal(MAX_GAZE_X * side, -MAX_GAZE_Y * 0.78, 12);
      if (Math.random() < 0.45 && !st.activeBubble) {
        popBubble("thinking", 1300);
      }
      st.scanQueue = [{ x: 0, y: 0, speed: 6, wait: 1100 }];
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 1250);
      return;
    }

    if (st.idleStage === "drowsy") {
      setGazeGoal((Math.random() - 0.5) * 3.5, 1.4 + Math.random() * 1.4, 4);
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 2400 + Math.random() * 2000);
      return;
    }

    const roll = Math.random();
    if (roll < 0.32) {
      const spot = pickRandomSpot();
      setGazeGoal(spot.x, spot.y, 13);
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 950 + Math.random() * 1700);
    } else if (roll < 0.62) {
      const p1 = pickRandomSpot();
      const p2 = pickRandomSpot();
      st.scanQueue = [
        { x: p1.x, y: p1.y, speed: 14, wait: 560 },
        { x: p2.x, y: p2.y, speed: 14, wait: 580 },
        { x: (Math.random() - 0.5) * 2.5, y: 0, speed: 6.5, wait: 1100 },
      ];
      scheduleNextGaze();
    } else {
      setGazeGoal(
        st.targetGx + (Math.random() - 0.5) * 4.5,
        st.targetGy + (Math.random() - 0.5) * 2.8,
        5.5
      );
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 1300 + Math.random() * 1400);
    }
  }, [popBubble, setGazeGoal]);

  const runStreamingStep = useCallback(() => {
    if (streamTimerRef.current !== null) {
      window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    if (!activeRef.current || !isStreamingRef.current) return;
    const pts = [
      { x: -7.5, y: -1.8, speed: 14, wait: 290 },
      { x: 0.5, y: -1.4, speed: 10, wait: 280 },
      { x: 7.5, y: -1.0, speed: 12, wait: 310 },
      { x: -7.5, y: 1.6, speed: 16, wait: 290 },
      { x: 2.0, y: 1.8, speed: 9.5, wait: 340 },
    ];
    const st = animRef.current;
    const pt = pts[st.streamSweepStep % pts.length];
    st.streamSweepStep += 1;
    setGazeGoal(pt.x, pt.y, pt.speed, false);
    streamTimerRef.current = window.setTimeout(runStreamingStep, pt.wait);
  }, [setGazeGoal]);

  const runAgyWorkStep = useCallback(() => {
    if (agyWorkTimerRef.current !== null) {
      window.clearTimeout(agyWorkTimerRef.current);
      agyWorkTimerRef.current = null;
    }
    if (!activeRef.current || !isAntigravityWorkingRef.current) return;
    const st = animRef.current;
    if (!isStreamingRef.current && !st.isNear && !dragStateRef.current?.moved && st.dizzyLevel < 0.05 && !st.activeEvent) {
      const pts = [
        { x: -6.2, y: -1.2, speed: 9.5, wait: 740 },
        { x: 1.8, y: -1.0, speed: 7.5, wait: 660 },
        { x: 6.8, y: -0.6, speed: 8.5, wait: 760 },
        { x: 3.4, y: -3.2, speed: 9.0, wait: 620 },
        { x: -5.4, y: 1.4, speed: 10.0, wait: 700 },
        { x: 0.4, y: 1.1, speed: 7.0, wait: 820 },
      ];
      const pt = pts[st.agyWorkSweepStep % pts.length];
      st.agyWorkSweepStep += 1;
      setGazeGoal(pt.x, pt.y, pt.speed, false);
      agyWorkTimerRef.current = window.setTimeout(runAgyWorkStep, pt.wait);
      return;
    }
    agyWorkTimerRef.current = window.setTimeout(runAgyWorkStep, 450);
  }, [setGazeGoal]);

  const triggerMicroEvent = useCallback(
    (
      kind:
        | "blink"
        | "wink"
        | "wiggle"
        | "startle"
        | "headpat"
        | "micronod"
        | "fly"
        | "sneeze"
        | "taskdone"
        | "vibe"
    ) => {
      if (!activeRef.current) return;
      const st = animRef.current;
      st.lastInteractionTime = performance.now();
      st.idleStage = "alert";

      if (kind === "blink") {
        triggerBlink(165, false, true);
        setActiveEvent("blink", 420);
        return;
      }

      if (kind === "wink") {
        setActiveEvent("wink", 650);
        st.winkHoldR = 1;
        st.bounceY = -2;
        scheduleTransient(() => {
          animRef.current.winkHoldR = 0;
        }, 280);
        return;
      }

      if (kind === "wiggle") {
        setActiveEvent("wiggle_L", 1150);
        st.bounceY = -2;
        scheduleTransient(() => {
          if (animRef.current.activeEvent?.type.startsWith("wiggle")) setActiveEvent("wiggle_R", 900);
        }, 230);
        scheduleTransient(() => {
          if (animRef.current.activeEvent?.type.startsWith("wiggle")) setActiveEvent("wiggle_L", 670);
        }, 460);
        scheduleTransient(() => {
          if (animRef.current.activeEvent?.type.startsWith("wiggle")) setActiveEvent("wiggle_R", 440);
        }, 690);
        return;
      }

      if (kind === "startle") {
        setActiveEvent("surprised", 820);
        popBubble("surprised", 850);
        st.bounceSx = 0.94;
        st.bounceSy = 1.07;
        scheduleTransient(() => triggerBlink(145, false, false), 420);
        return;
      }

      if (kind === "headpat") {
        setActiveEvent("happy", 1650);
        popBubble("happy", 1700);
        flashSparkle(1550);
        st.bounceSx = 1.06;
        st.bounceSy = 0.93;
        return;
      }

      if (kind === "micronod") {
        setActiveEvent("micronod_droop", 2400);
        popBubble("sleepy", 1020);
        scheduleTransient(() => {
          if (animRef.current.activeEvent?.type !== "micronod_droop") return;
          setActiveEvent("surprised", 700);
          popBubble("surprised", 850);
          animRef.current.bounceY = -3;
          setGazeGoal(-6.5, -1, 16, false);
          scheduleTransient(() => setGazeGoal(6.0, -0.5, 16, false), 200);
          scheduleTransient(() => {
            setGazeGoal(0, 0, 9, true);
            triggerBlink(150, false, false);
          }, 430);
        }, 1050);
        return;
      }

      if (kind === "fly") {
        setActiveEvent("focused", 2500);
        popBubble("curious", 1100);
        const pts = [
          [-8, -5],
          [-4, -6],
          [2, -4],
          [7, -5.5],
          [9, -2],
          [3, -1],
          [-2, -3.5],
          [0, 0],
        ];
        pts.forEach((pt, idx) => {
          scheduleTransient(() => {
            if (animRef.current.activeEvent?.type === "focused") {
              setGazeGoal(pt[0], pt[1], idx === pts.length - 1 ? 15 : 6.5, false);
            }
          }, idx * 240);
        });
        scheduleTransient(() => triggerBlink(145, false, true), 1750);
        return;
      }

      if (kind === "sneeze") {
        setActiveEvent("sneeze_build", 1900);
        setGazeGoal(0, -4.5, 5, false);
        scheduleTransient(() => {
          if (!animRef.current.activeEvent) return;
          setActiveEvent("sneeze_pop", 420);
          triggerBlink(220, false, false);
          animRef.current.bounceSx = 1.09;
          animRef.current.bounceSy = 0.89;
          animRef.current.bounceY = 2.5;
          scheduleTransient(() => {
            setActiveEvent("shy", 1100);
            popBubble("shy", 1200);
            setGazeGoal(7.5, 3.2, 12, false);
          }, 260);
        }, 620);
        return;
      }

      if (kind === "vibe") {
        popBubble("music", 2000);
        return;
      }

      if (kind === "taskdone") {
        setActiveEvent("happy", 1300);
        popBubble("done", 1500);
        flashSparkle(1250);
        triggerBlink(145, false, true);
        st.bounceSx = 1.05;
        st.bounceSy = 0.94;
        st.bounceY = -1.5;
      }
    },
    [flashSparkle, popBubble, scheduleTransient, setActiveEvent, setGazeGoal, triggerBlink]
  );

  const triggerBatteryReaction = useCallback(
    (eventKind: "plug_in" | "unplugged" | "low" | "full") => {
      if (!activeRef.current) return;
      const now = performance.now();
      const st = animRef.current;
      if (batteryStepTimerRef.current !== null) {
        window.clearTimeout(batteryStepTimerRef.current);
        batteryStepTimerRef.current = null;
      }

      if (eventKind === "plug_in") {
        st.wriggleStart = now;
        st.wriggleDuration = 600;
        st.bounceY = -2.2;
        st.lastInteractionTime = now;
        st.idleStage = "alert";
        setGazeGoal(0, 0, 20, false);
        setActiveEvent("plug_wriggle", 620);
        batteryStepTimerRef.current = window.setTimeout(() => {
          batteryStepTimerRef.current = null;
          if (!activeRef.current) return;
          setActiveEvent("happy", 1700);
          triggerBlink(145, false, true);
        }, 620);
        flashRim("green", 2200);
        popBubble("bat_plug", 1920);
        return;
      }

      if (eventKind === "unplugged") {
        st.wriggleDuration = 0;
        st.lastInteractionTime = now;
        st.idleStage = "alert";
        setActiveEvent("surprised", 220);
        setGazeGoal(-6.0, 2.4, 16, false);
        batteryStepTimerRef.current = window.setTimeout(() => {
          batteryStepTimerRef.current = null;
          if (!activeRef.current) return;
          setActiveEvent("wiggle_L", 2400);
          triggerBlink(150, false, false);
        }, 230);
        popBubble("bat_unplug", 1840);
        return;
      }

      if (eventKind === "low") {
        st.wriggleDuration = 0;
        st.bounceY = 1.8;
        st.lastInteractionTime = now;
        setGazeGoal(0, 2.8, 6, false);
        setActiveEvent("tired_low", 3800);
        triggerBlink(280, false, false);
        flashRim("red", 2400);
        popBubble("bat_low", 2100);
        return;
      }

      if (eventKind === "full") {
        st.wriggleDuration = 0;
        st.bounceSx = 1.06;
        st.bounceSy = 0.93;
        st.bounceY = -2.8;
        st.lastInteractionTime = now;
        st.idleStage = "alert";
        setGazeGoal(0, 0, 16, false);
        setActiveEvent("happy", 2600);
        triggerBlink(145, false, true);
        flashSparkle(1550);
        flashRim("green", 2400);
        popBubble("bat_full", 2000);
      }
    },
    [flashRim, flashSparkle, popBubble, setActiveEvent, setGazeGoal, triggerBlink]
  );

  const startMusicVibeLoops = useCallback(() => {
    if (vibeBubbleTimerRef.current !== null) {
      window.clearTimeout(vibeBubbleTimerRef.current);
      vibeBubbleTimerRef.current = null;
    }
    if (vibeSubmoodTimerRef.current !== null) {
      window.clearTimeout(vibeSubmoodTimerRef.current);
      vibeSubmoodTimerRef.current = null;
    }

    const scheduleNextVibeBubble = () => {
      vibeBubbleTimerRef.current = window.setTimeout(() => {
        vibeBubbleTimerRef.current = null;
        if (!activeRef.current) return;
        const st = animRef.current;
        if (st.musicState !== "playing" || st.headphonesState !== "on") return;
        if (!st.activeBubble && !st.isNear && st.dizzyLevel < 0.05 && !dragStateRef.current?.moved) {
          st.vibeCycleIdx = (st.vibeCycleIdx + 1) % VIBE_BUBBLE_CYCLE.length;
          popBubble(VIBE_BUBBLE_CYCLE[st.vibeCycleIdx], 1550);
        }
        scheduleNextVibeBubble();
      }, 13500 + Math.round(Math.random() * 4500));
    };
    scheduleNextVibeBubble();

    const toggleSubmood = () => {
      vibeSubmoodTimerRef.current = window.setTimeout(() => {
        vibeSubmoodTimerRef.current = null;
        if (!activeRef.current) return;
        const st = animRef.current;
        if (st.musicState !== "playing" || st.headphonesState !== "on") return;
        st.vibeSubmood = st.vibeSubmood === "vibing_bliss" ? "vibing_cool" : "vibing_bliss";
        toggleSubmood();
      }, 4800 + Math.round(Math.random() * 2400));
    };
    toggleSubmood();
  }, [popBubble]);

  const startBoredPauseGlances = useCallback(() => {
    if (boredGlanceTimerRef.current !== null) {
      window.clearTimeout(boredGlanceTimerRef.current);
      boredGlanceTimerRef.current = null;
    }
    const nextGlance = () => {
      boredGlanceTimerRef.current = window.setTimeout(() => {
        boredGlanceTimerRef.current = null;
        if (!activeRef.current) return;
        const st = animRef.current;
        if (st.musicState !== "paused" || st.headphonesState !== "on") return;
        if (!st.isNear && !dragStateRef.current?.moved) {
          const dir = Math.random() < 0.5 ? -4.2 : 4.2;
          setGazeGoal(dir, 2.0 + Math.random() * 1.4, 5, false);
        }
        nextGlance();
      }, 1650);
    };
    nextGlance();
  }, [setGazeGoal]);

  const beginHeadphonesRemoval = useCallback(
    (withBoredBubble: boolean) => {
      const st = animRef.current;
      if (st.headphonesState === "off") return;
      if (hpRemoveFinishTimerRef.current !== null) {
        window.clearTimeout(hpRemoveFinishTimerRef.current);
      }
      st.headphonesState = "removing";
      setPersistentRim("none");
      syncHeadphonesIpc("removing", false, false);
      st.bounceSx = 1.04;
      st.bounceSy = 0.96;
      st.bounceY = 1.8;
      setGazeGoal(0, 0, 8, false);
      if (withBoredBubble) {
        popBubble("music_bored", 1360);
      }
      hpRemoveFinishTimerRef.current = window.setTimeout(() => {
        hpRemoveFinishTimerRef.current = null;
        if (animRef.current.headphonesState === "removing") {
          animRef.current.headphonesState = "off";
        }
      }, 540);
    },
    [popBubble, setGazeGoal, setPersistentRim, syncHeadphonesIpc]
  );

  const triggerSpotifyReaction = useCallback(
    (eventKind: "play" | "resume" | "pause" | "track_change" | "stop") => {
      if (!activeRef.current) return;
      const now = performance.now();
      const st = animRef.current;

      if (eventKind === "play" || eventKind === "resume") {
        clearMusicTimers();
        const wearingAlready = st.headphonesState === "on";
        st.musicState = "playing";
        st.headphonesState = "on";
        st.beatStart = now;
        st.liveBeatSyncedAt = now;
        st.vibeSubmood = "vibing_bliss";
        st.lastInteractionTime = now;
        st.idleStage = "alert";

        syncHeadphonesIpc("on", true, false);
        syncMusicBopIpc(true, eventKind === "play");
        setPersistentRim("none");

        st.bounceY = -3.4;
        st.bounceSx = 1.07;
        st.bounceSy = 0.92;
        setGazeGoal(0, -0.8, 18, false);
        flashSparkle(1250);

        if (!wearingAlready) {
          setActiveEvent("excited_music", 420);
          musicStepTimerRef.current = window.setTimeout(() => {
            musicStepTimerRef.current = null;
            if (!activeRef.current || animRef.current.musicState !== "playing") return;
            setActiveEvent("happy", 1050);
            triggerBlink(140, false, true);
          }, 420);
          st.vibeCycleIdx = eventKind === "resume" ? 3 : 0;
          popBubble(eventKind === "resume" ? "music_vibe" : "music_eq", 1760);
        } else {
          setActiveEvent("happy", 950);
          triggerBlink(140, false, true);
          st.vibeCycleIdx = 0;
          popBubble("music_eq", 1680);
        }

        startMusicVibeLoops();
        return;
      }

      if (eventKind === "track_change") {
        if (st.musicState !== "playing" || st.headphonesState !== "on") return;
        syncMusicBopIpc(true, true);
        st.bounceY = -2.2;
        st.bounceSx = 1.05;
        st.bounceSy = 0.95;
        setActiveEvent("happy", 820);
        triggerBlink(145, false, false);
        flashSparkle(900);
        st.vibeCycleIdx = 2;
        popBubble("music_vinyl", 1700);
        return;
      }

      if (eventKind === "pause") {
        clearMusicTimers();
        const wasWearing = st.headphonesState === "on";
        st.musicState = "paused";
        syncMusicBopIpc(false, false);
        if (!wasWearing) {
          setPersistentRim("none");
          return;
        }
        syncHeadphonesIpc("on", false, true);
        setPersistentRim("none");
        st.bounceY = 1.8;
        setGazeGoal(-3.8, 2.2, 7, false);
        setActiveEvent("wiggle_L", 340);
        popBubble("music_pause", 1680);
        startBoredPauseGlances();

        pauseStowTimerRef.current = window.setTimeout(() => {
          pauseStowTimerRef.current = null;
          if (!activeRef.current || animRef.current.musicState !== "paused") return;
          if (boredGlanceTimerRef.current !== null) {
            window.clearTimeout(boredGlanceTimerRef.current);
            boredGlanceTimerRef.current = null;
          }
          beginHeadphonesRemoval(true);
        }, SPOTIFY_PAUSE_STOW_MS);
        return;
      }

      if (eventKind === "stop") {
        clearMusicTimers();
        const wasWearing = st.headphonesState === "on";
        st.musicState = "stopped";
        syncMusicBopIpc(false, false);
        if (wasWearing) {
          beginHeadphonesRemoval(true);
        } else {
          setPersistentRim("none");
        }
      }
    },
    [
      beginHeadphonesRemoval,
      clearMusicTimers,
      flashSparkle,
      popBubble,
      setActiveEvent,
      setGazeGoal,
      setPersistentRim,
      startBoredPauseGlances,
      startMusicVibeLoops,
      syncHeadphonesIpc,
      syncMusicBopIpc,
      triggerBlink,
    ]
  );

  const scheduleRareIdleMoment = useCallback(() => {
    if (rareTimerRef.current !== null) {
      window.clearTimeout(rareTimerRef.current);
      rareTimerRef.current = null;
    }
    if (!activeRef.current) return;
    rareTimerRef.current = window.setTimeout(() => {
      rareTimerRef.current = null;
      if (!activeRef.current) return;
      const st = animRef.current;
      if (
        !isAwakeRef.current &&
        !isStreamingRef.current &&
        !isAntigravityWorkingRef.current &&
        !st.isNear &&
        !dragStateRef.current?.moved &&
        !st.activeEvent &&
        st.headphonesState !== "on" &&
        st.dizzyLevel < 0.04
      ) {
        if (st.idleStage === "drowsy") {
          if (Math.random() < 0.38) triggerMicroEvent("micronod");
        } else {
          const r = Math.random();
          if (r < 0.20) triggerMicroEvent("fly");
          else if (r < 0.32) triggerMicroEvent("wink");
          else if (r < 0.40) triggerMicroEvent("wiggle");
          else if (r < 0.46) triggerMicroEvent("sneeze");
          else if (r < 0.54) triggerMicroEvent("vibe");
        }
      }
      scheduleRareIdleMoment();
    }, 18000 + Math.random() * 14000);
  }, [triggerMicroEvent]);

  const handleCursorSample = useCallback(
    (dx: number, dy: number, forceRefresh = false) => {
      if (!activeRef.current || dragStateRef.current?.moved || animRef.current.dizzyLevel > 0.04) {
        return;
      }

      const st = animRef.current;
      const now = performance.now();
      const dist = Math.hypot(dx, dy);
      st.cursorDist = dist;
      st.cursorDx = dx;

      const prev = prevCursorRef.current;
      const dt = Math.max(8, now - prev.t);
      const hasValidVel = prev.valid && dt < 140;
      const cvx = hasValidVel ? (dx - prev.dx) / dt : 0;
      const cvy = hasValidVel ? (dy - prev.dy) / dt : 0;
      const cSpeed = Math.hypot(cvx, cvy);

      prevCursorRef.current = { dx, dy, t: now, valid: dist <= 540 };

      const hoveringNow = dist <= 38;
      st.isHovered = hoveringNow;

      // Gentle Headpat: oscillating horizontal stroke across the cube without mouse button down
      if (hasValidVel && dist <= 48 && Math.abs(cvx) > 0.035 && cSpeed < 2.2) {
        const sign = Math.sign(cvx);
        const hp = headpatRef.current;
        if (sign !== 0 && sign !== hp.lastSign) {
          hp.crossings = now - hp.lastTime < 650 ? hp.crossings + 1 : 1;
          hp.lastSign = sign;
          hp.lastTime = now;
          if (hp.crossings >= 3) {
            hp.crossings = 0;
            triggerMicroEvent("headpat");
          }
        }
      }

      // Fast Whip-By Startle
      if (hasValidVel && dist < 135 && cSpeed > 2.35 && now - st.lastInteractionTime > 120) {
        if (st.activeEvent?.type !== "surprised") {
          setActiveEvent("surprised", 640);
          popBubble("surprised", 850);
          setGazeGoal((dx / Math.max(1, dist)) * MAX_GAZE_X, (dy / Math.max(1, dist)) * MAX_GAZE_Y, 20, false);
        }
      }

      const within = st.isNear ? dist <= EXIT_RADIUS : dist <= ENTER_RADIUS;

      if (within) {
        const justEntered = !st.isNear;
        st.isNear = true;
        st.lastInteractionTime = now;
        st.idleStage = "alert";
        st.scanQueue = [];

        if (hoveringNow) {
          setGazeGoal(0, 0, 14, justEntered);
        } else {
          const reach = Math.min(1, dist / REACH_DIST);
          const nx = dist < 4 ? 0 : (dx / dist) * MAX_GAZE_X * reach;
          const ny = dist < 4 ? 0 : (dy / dist) * MAX_GAZE_Y * reach;
          setGazeGoal(nx, ny, justEntered || forceRefresh ? 12 : 16, justEntered);

          // Close curious inspection (<175px) pops "?" bubble cleanly (with anti-spam cooldown)
          if (dist < 175 && !isStreamingRef.current && !st.activeEvent && now > st.curiousCooldownUntil) {
            popBubble("curious", 2100);
            st.curiousCooldownUntil = now + 8200;
          }
        }
      } else if (st.isNear || forceRefresh) {
        st.isNear = false;
        st.isHovered = false;
        if (st.activeBubble?.kind === "curious") {
          st.activeBubble = null;
        }
      }
    },
    [popBubble, setActiveEvent, setGazeGoal, triggerMicroEvent]
  );

  // React to streaming start/finish while cube is active & awake
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!active) return;

    if (isStreaming) {
      if (!wasStreaming) {
        popBubble("working", 2400);
      }
      runStreamingStep();
    } else if (streamTimerRef.current !== null) {
      window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }

    if (wasStreaming && !isStreaming && isAwake) {
      triggerMicroEvent("taskdone");
    }
  }, [active, isAwake, isStreaming, popBubble, runStreamingStep, triggerMicroEvent]);

  // React to Antigravity background worker running state while in Living Cube mode
  useEffect(() => {
    if (!active) return;
    const st = animRef.current;
    if (isAntigravityWorking) {
      st.lastInteractionTime = performance.now();
      st.idleStage = "alert";
      setPersistentRim("work_green");
      if (!st.activeBubble) {
        st.activeBubble = { kind: "work_gear", expiresAt: performance.now() + 3500 };
      }
      runAgyWorkStep();
    } else {
      if (agyWorkTimerRef.current !== null) {
        window.clearTimeout(agyWorkTimerRef.current);
        agyWorkTimerRef.current = null;
      }
      if (st.activeBubble?.kind === "work_gear") {
        st.activeBubble = null;
      }
      if (persistentRimRef.current === "work_green") {
        setPersistentRim("none");
      }
    }
  }, [active, isAntigravityWorking, runAgyWorkStep, setPersistentRim]);

  // Trigger celebratory finished animation in Living Cube when an Antigravity task completes
  useEffect(() => {
    if (antigravityDoneSeq <= lastHandledAgyDoneSeqRef.current) return;
    lastHandledAgyDoneSeqRef.current = antigravityDoneSeq;
    if (!active) return;

    const st = animRef.current;
    st.lastInteractionTime = performance.now();
    st.idleStage = "alert";
    if (st.activeBubble?.kind === "work_gear") {
      st.activeBubble = null;
    }
    setPersistentRim("none");
    flashRim("green", 2800);
    setActiveEvent("happy", 2600);
    popBubble("done", 2400);
    flashSparkle(2200);
    triggerBlink(145, false, true);
    st.bounceSx = 1.09;
    st.bounceSy = 0.89;
    st.bounceY = -3.4;
    setGazeGoal(0, -1.2, 16, false);
  }, [
    active,
    antigravityDoneSeq,
    flashRim,
    flashSparkle,
    popBubble,
    setActiveEvent,
    setGazeGoal,
    setPersistentRim,
    triggerBlink,
  ]);

  // Brief surprised reaction in Living Cube if an Antigravity task fails
  useEffect(() => {
    if (antigravityFailedSeq <= lastHandledAgyFailedSeqRef.current) return;
    lastHandledAgyFailedSeqRef.current = antigravityFailedSeq;
    if (!active) return;

    const st = animRef.current;
    st.lastInteractionTime = performance.now();
    st.idleStage = "alert";
    if (st.activeBubble?.kind === "work_gear") {
      st.activeBubble = null;
    }
    setPersistentRim("none");
    flashRim("red", 2200);
    setActiveEvent("surprised", 1500);
    popBubble("surprised", 1600);
    st.bounceY = -2.0;
    setGazeGoal(0, 0, 16, false);
  }, [
    active,
    antigravityFailedSeq,
    flashRim,
    popBubble,
    setActiveEvent,
    setGazeGoal,
    setPersistentRim,
  ]);

  // Wake into alert state if isAwake changes
  useEffect(() => {
    if (!active) return;
    animRef.current.lastInteractionTime = performance.now();
    animRef.current.idleStage = "alert";
  }, [active, isAwake]);

  // Keep open bubble & headphones theme synced immediately if dark/light mode flips
  useEffect(() => {
    if (active && lastSentBubbleRef.current !== null) {
      invoke("set_pip_bubble", {
        kind: lastSentBubbleRef.current,
        darkMode: isDarkMode,
        batteryPct: animRef.current.batteryPct,
      }).catch(() => {});
    }
    if (active && animRef.current.headphonesState === "on") {
      invoke("set_pip_headphones", {
        mode: "on",
        darkMode: isDarkMode,
        playing: animRef.current.musicState === "playing",
        paused: animRef.current.musicState === "paused",
        bpm: SPOTIFY_GROOVE_BPM,
      }).catch(() => {});
    }
  }, [active, isDarkMode]);

  // Main 60fps animation engine & Tauri cursor watcher lifecycle
  useEffect(() => {
    if (!active) {
      clearAllTimers();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      animRef.current.dizzyLevel = 0;
      animRef.current.activeBlink = null;
      animRef.current.activeEvent = null;
      animRef.current.activeBubble = null;
      animRef.current.wriggleDuration = 0;
      animRef.current.musicState = "stopped";
      animRef.current.headphonesState = "off";
      persistentRimRef.current = "none";
      syncBubbleIpc(null);
      syncHeadphonesIpc("off", false, false);
      syncMusicBopIpc(false, false);
      dragStateRef.current = null;
      prevCursorRef.current.valid = false;
      headpatRef.current = { crossings: 0, lastSign: 0, lastTime: 0 };
      setShowSparkle(false);
      onRimToneChangeRef.current?.("none");
      onDragVisualChangeRef.current(false, false);
      return;
    }

    // Reset clean neutral posture on activation
    const st = animRef.current;
    st.gx = 0;
    st.gy = 0;
    st.targetGx = 0;
    st.targetGy = 0;
    st.tilt = 0;
    st.targetTilt = 0;
    st.op = 1;
    st.bounceSx = 1;
    st.bounceSy = 1;
    st.bounceY = 0;
    st.L = cloneShape(EXPR_PRESETS.neutral.L);
    st.R = cloneShape(EXPR_PRESETS.neutral.R);
    st.winkHoldR = 0;
    st.dizzyLevel = 0;
    st.isHovered = false;
    st.isNear = false;
    st.idleStage = "alert";
    st.lastInteractionTime = performance.now();
    st.activeEvent = null;
    st.activeBubble = null;
    st.curiousCooldownUntil = 0;
    st.drowsyBubbleCooldownUntil = 0;
    st.activeBlink = null;
    st.scanQueue = [];
    lastDomRef.current = { eyesTf: "", slotLTf: "", slotRTf: "", pathL: "", pathR: "", op: "" };

    scheduleNextBlink();
    gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 650);
    scheduleRareIdleMoment();
    if (isStreamingRef.current) {
      runStreamingStep();
    }
    if (isAntigravityWorkingRef.current) {
      setPersistentRim("work_green");
      st.activeBubble = { kind: "work_gear", expiresAt: performance.now() + 3500 };
      runAgyWorkStep();
    }

    invoke<{ dx?: number; dy?: number }>("get_pip_cursor_delta")
      .then((res) => {
        if (activeRef.current && typeof res?.dx === "number" && typeof res?.dy === "number") {
          handleCursorSample(res.dx, res.dy, true);
        }
      })
      .catch(() => {});

    let unlistenCursor: (() => void) | undefined;
    let unlistenPower: (() => void) | undefined;
    let unlistenSpotify: (() => void) | undefined;
    let unlistenBeat: (() => void) | undefined;
    let disposed = false;

    listen<{ dx: number; dy: number }>("pip-cursor-update", (event) => {
      if (!disposed && event.payload) {
        handleCursorSample(event.payload.dx, event.payload.dy);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenCursor = unlisten;
        }
      })
      .catch(() => {});

    invoke<{ hasBattery?: boolean; pluggedIn?: boolean; percent?: number }>("get_pip_power_status")
      .then((res) => {
        if (!disposed && res && typeof res.hasBattery === "boolean") {
          animRef.current.hasBattery = res.hasBattery;
          animRef.current.pluggedIn = Boolean(res.pluggedIn);
          if (typeof res.percent === "number") {
            animRef.current.batteryPct = res.percent;
          }
          if (!animRef.current.hasBattery || animRef.current.pluggedIn || animRef.current.batteryPct > 20) {
            lowWarnedRef.current = false;
          } else if (!lowWarnedRef.current) {
            lowWarnedRef.current = true;
            triggerBatteryReaction("low");
          }
        }
      })
      .catch(() => {});

    listen<{
      hasBattery?: boolean;
      pluggedIn?: boolean;
      percent?: number;
      event?: "plug_in" | "unplugged" | "low" | "full" | null;
    }>("pip-power-update", (event) => {
      if (disposed || !event.payload) return;
      const p = event.payload;
      const stNow = animRef.current;
      if (typeof p.hasBattery === "boolean") stNow.hasBattery = p.hasBattery;
      if (typeof p.pluggedIn === "boolean") stNow.pluggedIn = p.pluggedIn;
      if (typeof p.percent === "number") stNow.batteryPct = p.percent;
      if (!stNow.hasBattery || stNow.pluggedIn || stNow.batteryPct > 20) {
        lowWarnedRef.current = false;
      }
      if (p.event) {
        if (p.event === "low") lowWarnedRef.current = true;
        triggerBatteryReaction(p.event);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenPower = unlisten;
        }
      })
      .catch(() => {});

    invoke<{
      running?: boolean;
      playing?: boolean;
      paused?: boolean;
      hasTrack?: boolean;
      trackKey?: string;
    }>("get_pip_spotify_status")
      .then((res) => {
        if (disposed || !res) return;
        animRef.current.spotifyRunning = Boolean(res.running);
        if (res.running && res.playing && res.hasTrack) {
          triggerSpotifyReaction("play");
        } else {
          animRef.current.musicState = res.paused ? "paused" : "stopped";
        }
      })
      .catch(() => {});

    listen<{
      running?: boolean;
      playing?: boolean;
      paused?: boolean;
      hasTrack?: boolean;
      trackKey?: string;
      event?: "play" | "resume" | "pause" | "track_change" | "stop" | null;
    }>("pip-spotify-update", (event) => {
      if (disposed || !event.payload) return;
      const p = event.payload;
      animRef.current.spotifyRunning = Boolean(p.running);
      if (p.event) {
        triggerSpotifyReaction(p.event);
      } else if (!p.running && animRef.current.headphonesState === "on") {
        triggerSpotifyReaction("stop");
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenSpotify = unlisten;
        }
      })
      .catch(() => {});

    listen<{
      active?: boolean;
      bpm?: number;
      beatCount?: number;
      sway?: "head_nod" | "beat_hop";
    }>("pip-beat-sync", (event) => {
      if (disposed || !event.payload) return;
      const p = event.payload;
      const stNow = animRef.current;
      if (typeof p.bpm === "number" && p.bpm >= 60 && p.bpm <= 180) {
        stNow.liveBpm = p.bpm;
      }
      if (typeof p.beatCount === "number") {
        stNow.liveBeatCount = p.beatCount;
        stNow.liveBeatSyncedAt = performance.now();
      }
      if (p.sway === "head_nod" || p.sway === "beat_hop") {
        stNow.liveSway = p.sway;
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenBeat = unlisten;
        }
      })
      .catch(() => {});

    prevFrameRef.current = performance.now();

    const tick = (now: number) => {
      if (!activeRef.current) {
        rafRef.current = null;
        return;
      }

      const dtSec = Math.min(0.05, Math.max(0.004, (now - prevFrameRef.current) / 1000));
      prevFrameRef.current = now;
      const cur = animRef.current;

      if (cur.activeEvent && now >= cur.activeEvent.endsAt) {
        cur.activeEvent = null;
      }
      if (cur.activeBubble && now >= cur.activeBubble.expiresAt) {
        cur.activeBubble = null;
      }

      // Circadian & idle progression (only when Asleep and idle)
      const idleSec = (now - cur.lastInteractionTime) / 1000;
      const hour = new Date().getHours();
      const isNight = hour >= 0 && hour < 6;
      const relaxThreshold = isNight ? 14 : 24;
      const dozeThreshold = isNight ? 30 : 50;

      const isGrooving = cur.musicState === "playing" && cur.headphonesState === "on";
      const isBoredWaiting = cur.musicState === "paused" && cur.headphonesState === "on";

      if (
        !isAwakeRef.current &&
        !isStreamingRef.current &&
        !isAntigravityWorkingRef.current &&
        !isGrooving &&
        !isBoredWaiting &&
        !cur.isNear &&
        !dragStateRef.current?.moved &&
        !cur.activeEvent
      ) {
        cur.idleStage = idleSec > dozeThreshold ? "drowsy" : idleSec > relaxThreshold ? "relaxed" : "alert";
        if (cur.idleStage === "drowsy" && !cur.activeBubble && now > cur.drowsyBubbleCooldownUntil) {
          popBubble("sleepy", 2600);
          cur.drowsyBubbleCooldownUntil = now + 18000;
        }
      } else if (isAwakeRef.current || isStreamingRef.current || isAntigravityWorkingRef.current || isGrooving) {
        cur.idleStage = "alert";
      }

      // Keep the rotating grey gear comment bubble visible while Antigravity is working
      // (yields automatically to hover/curious, drag/dizzy, headpat, battery, or music bubbles)
      if (
        isAntigravityWorkingRef.current &&
        !cur.activeEvent &&
        !cur.isNear &&
        !dragStateRef.current?.moved &&
        cur.dizzyLevel < 0.05
      ) {
        if (!cur.activeBubble || (cur.activeBubble.kind === "work_gear" && cur.activeBubble.expiresAt - now < 1200)) {
          cur.activeBubble = { kind: "work_gear", expiresAt: now + 3500 };
        }
      } else if (!isAntigravityWorkingRef.current && cur.activeBubble?.kind === "work_gear") {
        cur.activeBubble = null;
      }

      syncBubbleIpc(cur.activeBubble ? cur.activeBubble.kind : null);

      // Rhythmic Spotify groove offsets synced to Rust's live WASAPI beat clock
      let beatEyeX = 0;
      let beatEyeY = 0;
      let beatTilt = 0;
      const grooveEyesActive =
        isGrooving && !cur.isNear && !cur.isHovered && !dragStateRef.current?.moved && !cur.activeEvent;
      if (grooveEyesActive) {
        const bpmNow = Math.max(72, Math.min(152, cur.liveBpm || SPOTIFY_GROOVE_BPM));
        const elapsedSinceSync = Math.max(0, (now - cur.liveBeatSyncedAt) / 1000);
        const beatCount = cur.liveBeatCount + elapsedSinceSync * (bpmNow / 60);
        const beatPhase = beatCount % 1;
        const beatIdx = Math.floor(beatCount);
        const isHeadNod = Math.floor(beatIdx / 8) % 2 === 0;

        if (isHeadNod) {
          let nodCurve = 0;
          if (beatPhase < 0.22) {
            const u = beatPhase / 0.22;
            nodCurve = Math.sin(u * (Math.PI / 2));
          } else {
            const u = (beatPhase - 0.22) / 0.78;
            nodCurve = Math.cos(u * (Math.PI / 2)) - Math.sin(u * Math.PI) * 0.16;
          }
          const barLean = Math.sin(beatCount * Math.PI * 0.5);
          beatEyeX = barLean * 1.4;
          beatEyeY = nodCurve * 2.2 - 0.6;
          beatTilt = barLean * 2.4;
        } else {
          const side = beatIdx % 2 === 0 ? -1 : 1;
          const stepEase = 1 - Math.pow(1 - Math.min(1, beatPhase * 2.2), 3);
          const xPos = lerp(-side, side, stepEase);
          const hopArc = -Math.sin(Math.min(1, beatPhase * 1.7) * Math.PI) * 2.2;
          beatEyeX = xPos * 3.6;
          beatEyeY = hopArc * 0.3;
          beatTilt = xPos * 3.8;
        }
      }

      // Determine active target expression
      let chosenName = "neutral";
      let flipWiggle = false;
      let wriggleOffset = 0;
      if (cur.activeEvent) {
        const et = cur.activeEvent.type;
        if (et === "plug_wriggle") {
          const elapsed = now - cur.wriggleStart;
          const phase = Math.sin((elapsed / 110) * Math.PI);
          wriggleOffset = phase * 2.4;
          chosenName = "curious";
          flipWiggle = phase < 0;
        } else if (et === "tired_low") chosenName = "tired_low";
        else if (et === "excited_music") chosenName = "excited_music";
        else if (et === "surprised") chosenName = "surprised";
        else if (et === "happy") chosenName = "happy";
        else if (et === "annoyed") chosenName = "annoyed";
        else if (et === "shy") chosenName = "shy";
        else if (et === "focused" || et === "sneeze_build") chosenName = "focused";
        else if (et === "sneeze_pop") chosenName = "annoyed";
        else if (et === "micronod_droop") chosenName = "sleepy";
        else if (et === "wiggle_L") chosenName = "curious";
        else if (et === "wiggle_R") {
          chosenName = "curious";
          flipWiggle = true;
        }
      } else if (isStreamingRef.current) {
        chosenName = "focused";
      } else if (cur.isHovered) {
        chosenName = "surprised";
      } else if (cur.isNear && cur.cursorDist < 175) {
        chosenName = "curious";
      } else if (isAntigravityWorkingRef.current) {
        chosenName = "working_agy";
      } else if (isGrooving) {
        chosenName = cur.vibeSubmood;
      } else if (isBoredWaiting) {
        chosenName = "bored_pause";
      } else if (cur.hasBattery && !cur.pluggedIn && cur.batteryPct <= 20) {
        chosenName = "tired_low";
      } else if (!isAwakeRef.current && cur.idleStage === "drowsy") {
        chosenName = "sleepy";
      } else if (!isAwakeRef.current && cur.idleStage === "relaxed") {
        chosenName = "chill";
      }

      const preset = EXPR_PRESETS[chosenName] || EXPR_PRESETS.neutral;

      let desiredTilt = (flipWiggle ? -preset.tilt : preset.tilt) + beatTilt;
      if (chosenName === "curious" && !flipWiggle && cur.isNear) {
        desiredTilt = Math.max(-5.5, Math.min(5.5, (cur.cursorDx / 170) * 5.2));
      } else if (cur.isNear && !dragStateRef.current?.moved) {
        desiredTilt += Math.max(-3, Math.min(3, (cur.cursorDx / 240) * 2.5));
      }

      const targetL = cloneShape(flipWiggle ? preset.R : preset.L);
      const targetR = cloneShape(flipWiggle ? preset.L : preset.R);

      if (cur.isHovered && !cur.activeEvent) {
        targetL.sy = 1.09;
        targetR.sy = 1.09;
        targetL.sx = 1.04;
        targetR.sx = 1.04;
      }

      let breathOp = isNight && !isAwakeRef.current && chosenName === "sleepy" ? preset.op * 0.9 : preset.op;
      let breathDy = 0;
      if (chosenName === "happy" || chosenName === "vibing_bliss") {
        breathDy = Math.sin(now * 0.011) * 0.9;
      } else if (chosenName === "working_agy") {
        breathDy = Math.sin(now * 0.0052) * 0.55;
      } else if (chosenName === "bored_pause") {
        breathDy = Math.sin(now * 0.0028) * 1.0 + 0.5;
      } else if (chosenName === "tired_low") {
        breathDy = Math.sin(now * 0.0025) * 0.8 + 0.5;
      } else if (chosenName === "sleepy") {
        const breath = Math.sin(now * 0.0022);
        breathOp = breathOp + breath * 0.06;
        breathDy = breath * 0.7 + (cur.activeEvent?.type === "micronod_droop" ? 2.2 : 0);
        if (cur.activeEvent?.type === "micronod_droop") {
          targetL.outer = 37;
          targetL.mid = 39;
          targetL.inner = 37;
          targetR.outer = 37;
          targetR.mid = 39;
          targetR.inner = 37;
        }
      }
      if (cur.activeEvent?.type === "sneeze_build") {
        breathDy = -1.2 + Math.sin(now * 0.045) * 0.45;
      }

      // Active top-down blink progress
      let blinkValL = 0;
      let blinkValR = cur.winkHoldR;
      if (cur.activeBlink) {
        const b = cur.activeBlink;
        const p = (now - b.start) / b.duration;
        if (p >= 1) {
          cur.activeBlink = null;
          if (b.forceDouble || (b.allowDouble && Math.random() < 0.16)) {
            scheduleTransient(() => triggerBlink(145, false, false), 115);
          }
        } else {
          let shut = 0;
          if (p < 0.38) shut = Math.sin((p / 0.38) * (Math.PI / 2));
          else if (p < 0.52) shut = 1;
          else shut = Math.cos(((p - 0.52) / 0.48) * (Math.PI / 2));
          if (b.eyes !== "R") blinkValL = Math.max(blinkValL, shut);
          if (b.eyes !== "L") blinkValR = Math.max(blinkValR, shut);
        }
      }

      // Dizzy recovery decay
      if (!dragStateRef.current?.moved && cur.dizzyLevel > 0) {
        cur.dizzyLevel *= Math.pow(0.0068, dtSec);
        if (cur.dizzyLevel <= 0.025) {
          cur.dizzyLevel = 0;
          onDragVisualChangeRef.current(false, false);
          triggerBlink(145, false, true);
          scheduleNextBlink();
          scheduleTransient(() => {
            invoke<{ dx?: number; dy?: number }>("get_pip_cursor_delta")
              .then((res) => {
                if (activeRef.current && !dragStateRef.current?.moved && typeof res?.dx === "number" && typeof res?.dy === "number") {
                  handleCursorSample(res.dx, res.dy, true);
                }
              })
              .catch(() => {});
          }, 260);
        } else {
          onDragVisualChangeRef.current(false, true);
        }
      }

      // Interpolate springs
      const morphK = 1 - Math.exp(-15 * dtSec);
      const gazeK = 1 - Math.exp(-cur.gazeLerp * dtSec);
      const bounceK = 1 - Math.exp(-18 * dtSec);

      const effTargetGx = grooveEyesActive ? beatEyeX : cur.targetGx;
      const effTargetGy = grooveEyesActive ? beatEyeY : cur.targetGy;
      cur.gx = lerp(cur.gx, effTargetGx, gazeK);
      cur.gy = lerp(cur.gy, effTargetGy, gazeK);
      cur.tilt = lerp(cur.tilt, desiredTilt, morphK);
      cur.op = lerp(cur.op, breathOp, morphK);
      cur.bounceSx = lerp(cur.bounceSx, 1, bounceK);
      cur.bounceSy = lerp(cur.bounceSy, 1, bounceK);
      cur.bounceY = lerp(cur.bounceY, 0, bounceK);

      const stepShape = (c: EyeShape, t: EyeShape) => {
        c.outer = lerp(c.outer, t.outer, morphK);
        c.mid = lerp(c.mid, t.mid, morphK);
        c.inner = lerp(c.inner, t.inner, morphK);
        c.sx = lerp(c.sx, t.sx, morphK);
        c.sy = lerp(c.sy, t.sy, morphK);
        c.dy = lerp(c.dy, t.dy + breathDy, morphK);
      };
      stepShape(cur.L, targetL);
      stepShape(cur.R, targetR);

      // Final coordinates including dizzy oscillation
      let ldx = 0;
      let ldy = cur.L.dy;
      let rdx = 0;
      let rdy = cur.R.dy;
      let lsx = cur.L.sx;
      const lsy = cur.L.sy;
      let rsx = cur.R.sx;
      const rsy = cur.R.sy;
      let finalLsy = lsy;
      let finalRsy = rsy;
      let finalOp = cur.op;

      if (cur.dizzyLevel > 0.025) {
        cur.dizzyPhase += dtSec * (10.5 + cur.dizzyLevel * 16.5);
        const p = cur.dizzyPhase;
        const ampX = 1.6 + cur.dizzyLevel * 3.8;
        const ampY = 1.1 + cur.dizzyLevel * 3.1;
        const crossEye = cur.dizzyLevel * 1.4;
        ldx += Math.cos(p) * ampX + crossEye;
        ldy += Math.sin(p * 1.32) * ampY;
        rdx += -Math.cos(p + 0.85) * ampX - crossEye;
        rdy += -Math.sin(p * 1.32 + 0.65) * ampY;
        finalLsy *= Math.max(0.46, 1 - cur.dizzyLevel * 0.24 + Math.sin(p * 1.6) * cur.dizzyLevel * 0.26);
        finalRsy *= Math.max(0.46, 1 - cur.dizzyLevel * 0.24 - Math.sin(p * 1.6 + 0.5) * cur.dizzyLevel * 0.26);
        lsx *= 1 + (1 - finalLsy) * 0.35;
        rsx *= 1 + (1 - finalRsy) * 0.35;
        finalOp = Math.max(0.42, 0.7 - cur.dizzyLevel * 0.28);
      }

      const lOuter = lerp(cur.L.outer, 45.5, blinkValL);
      const lMid = lerp(cur.L.mid, 45.5, blinkValL);
      const lInner = lerp(cur.L.inner, 45.5, blinkValL);
      const rOuter = lerp(cur.R.outer, 45.5, blinkValR);
      const rMid = lerp(cur.R.mid, 45.5, blinkValR);
      const rInner = lerp(cur.R.inner, 45.5, blinkValR);

      lsx += blinkValL * 0.14;
      rsx += blinkValR * 0.14;
      if (cur.winkHoldR > 0.5) {
        rsx = Math.max(rsx, 1.16);
      }

      const pathL = buildEyePath(lOuter, lMid, lInner, false);
      const pathR = buildEyePath(rOuter, rMid, rInner, true);

      const eyesTf = `translate3d(${(cur.gx + wriggleOffset).toFixed(2)}px, ${(cur.gy + cur.bounceY).toFixed(2)}px, 0) rotate(${cur.tilt.toFixed(2)}deg) scale(${cur.bounceSx.toFixed(3)}, ${cur.bounceSy.toFixed(3)})`;
      const slotLTf = `translate3d(${ldx.toFixed(2)}px, ${ldy.toFixed(2)}px, 0) scale(${lsx.toFixed(3)}, ${finalLsy.toFixed(3)})`;
      const slotRTf = `translate3d(${rdx.toFixed(2)}px, ${rdy.toFixed(2)}px, 0) scale(${rsx.toFixed(3)}, ${finalRsy.toFixed(3)})`;
      const opStr = finalOp.toFixed(2);

      const cache = lastDomRef.current;
      if (eyesRef.current) {
        if (cache.eyesTf !== eyesTf) {
          cache.eyesTf = eyesTf;
          eyesRef.current.style.transform = eyesTf;
        }
        if (cache.op !== opStr) {
          cache.op = opStr;
          eyesRef.current.style.opacity = opStr;
        }
      }
      if (leftSlotRef.current && cache.slotLTf !== slotLTf) {
        cache.slotLTf = slotLTf;
        leftSlotRef.current.style.transform = slotLTf;
      }
      if (rightSlotRef.current && cache.slotRTf !== slotRTf) {
        cache.slotRTf = slotRTf;
        rightSlotRef.current.style.transform = slotRTf;
      }
      if (leftPathRef.current && cache.pathL !== pathL) {
        cache.pathL = pathL;
        leftPathRef.current.setAttribute("d", pathL);
      }
      if (rightPathRef.current && cache.pathR !== pathR) {
        cache.pathR = pathR;
        rightPathRef.current.setAttribute("d", pathR);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      if (unlistenCursor) unlistenCursor();
      if (unlistenPower) unlistenPower();
      if (unlistenSpotify) unlistenSpotify();
      if (unlistenBeat) unlistenBeat();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      clearAllTimers();
      animRef.current.activeBubble = null;
      animRef.current.wriggleDuration = 0;
      animRef.current.musicState = "stopped";
      animRef.current.headphonesState = "off";
      persistentRimRef.current = "none";
      syncBubbleIpc(null);
      syncHeadphonesIpc("off", false, false);
      syncMusicBopIpc(false, false);
      onRimToneChangeRef.current?.("none");
      onDragVisualChangeRef.current(false, false);
    };
  }, [
    active,
    clearAllTimers,
    handleCursorSample,
    popBubble,
    runAgyWorkStep,
    runStreamingStep,
    scheduleNextBlink,
    scheduleNextGaze,
    scheduleRareIdleMoment,
    scheduleTransient,
    setPersistentRim,
    syncBubbleIpc,
    syncHeadphonesIpc,
    syncMusicBopIpc,
    triggerBatteryReaction,
    triggerBlink,
    triggerSpotifyReaction,
  ]);

  const flushNativeDragStep = useCallback((ds: DragState) => {
    if (ds.pendingStep) {
      ds.queuedStep = true;
      return;
    }
    ds.pendingStep = true;
    invoke("step_pip_drag")
      .catch(() => {})
      .finally(() => {
        ds.pendingStep = false;
        if (ds.queuedStep && dragStateRef.current === ds) {
          ds.queuedStep = false;
          flushNativeDragStep(ds);
        }
      });
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture unavailable
    }

    const now = performance.now();
    dragStateRef.current = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      prevScreenX: e.screenX,
      prevScreenY: e.screenY,
      prevTime: now,
      prevVx: 0,
      prevVy: 0,
      moved: false,
      peakDizzy: 0,
      pendingStep: false,
      queuedStep: false,
    };

    invoke("begin_pip_drag").catch(() => {});
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;

    const now = performance.now();
    const dxTotal = e.screenX - ds.startScreenX;
    const dyTotal = e.screenY - ds.startScreenY;

    if (!ds.moved && Math.hypot(dxTotal, dyTotal) >= 5) {
      ds.moved = true;
      const st = animRef.current;
      st.isNear = false;
      st.isHovered = false;
      st.activeEvent = null;
      st.activeBubble = null;
      st.scanQueue = [];
      headpatRef.current = { crossings: 0, lastSign: 0, lastTime: 0 };
      prevCursorRef.current.valid = false;
      st.dizzyLevel = Math.max(st.dizzyLevel, 0.32);
      ds.peakDizzy = Math.max(ds.peakDizzy, st.dizzyLevel);
      onDragVisualChangeRef.current(true, true);
    }

    if (ds.moved) {
      flushNativeDragStep(ds);

      const dt = Math.max(8, now - ds.prevTime);
      const vx = (e.screenX - ds.prevScreenX) / dt;
      const vy = (e.screenY - ds.prevScreenY) / dt;
      const speed = Math.hypot(vx, vy);

      // Opposite-velocity gaze inertia lag during drag
      setGazeGoal(-vx * 7.5, -vy * 7.5, 22, false);

      const prevSpd = Math.hypot(ds.prevVx, ds.prevVy);
      let reversalBoost = 0;
      if (prevSpd > 0.28 && speed > 0.28) {
        const dot = (ds.prevVx * vx + ds.prevVy * vy) / (prevSpd * speed);
        if (dot < -0.22) {
          reversalBoost = Math.min(0.45, (speed + prevSpd) * 0.2);
        }
      }
      const speedBoost = speed > 0.55 ? Math.min(0.2, (speed - 0.55) * 0.14) : 0.02;
      animRef.current.dizzyLevel = Math.min(
        1,
        Math.max(0.32, animRef.current.dizzyLevel) + reversalBoost + speedBoost
      );
      ds.peakDizzy = Math.max(ds.peakDizzy, animRef.current.dizzyLevel);
      if (animRef.current.dizzyLevel > 0.56) {
        popBubble("dizzy", 950);
      }

      ds.prevScreenX = e.screenX;
      ds.prevScreenY = e.screenY;
      ds.prevTime = now;
      ds.prevVx = vx;
      ds.prevVy = vy;
      animRef.current.lastInteractionTime = now;
    }
  };

  const finishInteraction = (e: React.PointerEvent<HTMLDivElement>, isCancel: boolean) => {
    const ds = dragStateRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    const wasDrag = ds.moved;
    const wasShakenHard = ds.peakDizzy > 0.68;
    dragStateRef.current = null;
    headpatRef.current = { crossings: 0, lastSign: 0, lastTime: 0 };

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }

    invoke("end_pip_drag").catch(() => {});

    if (wasDrag || isCancel) {
      const st = animRef.current;
      onDragVisualChangeRef.current(false, st.dizzyLevel > 0.025);
      // Tactile landing squash-and-stretch settle
      st.bounceSx = 1.08;
      st.bounceSy = 0.9;
      st.bounceY = 2.0;
      setGazeGoal(0, 0, 12, false);

      if (wasShakenHard && !isCancel) {
        scheduleTransient(() => {
          if (!dragStateRef.current && animRef.current.dizzyLevel < 0.08) {
            setActiveEvent("annoyed", 1900);
            popBubble("annoyed", 1950);
            setGazeGoal(-4.5, -1.5, 11, false);
            triggerBlink(145, false, true);
          }
        }, 720);
      }
      return;
    }

    if (active) {
      onMaximizeRef.current();
    }
  };

  return (
    <div
      className={`siri-pip-content ${showSparkle ? "show-sparkle" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => finishInteraction(e, false)}
      onPointerCancel={(e) => finishInteraction(e, true)}
      onLostPointerCapture={(e) => finishInteraction(e, true)}
      title={
        isAwake
          ? "Drag anywhere • Click to restore chat • Esc to sleep"
          : "Drag anywhere • Click to wake AIDEN"
      }
    >
      <div className="siri-pip-eyes" ref={eyesRef} aria-hidden="true">
        <div className="siri-pip-eye-slot" ref={leftSlotRef}>
          <div className="siri-pip-eye-pill">
            <svg className="siri-pip-eye-svg" viewBox="0 0 28 48" width="7" height="12" aria-hidden="true">
              <path
                ref={leftPathRef}
                fill="currentColor"
                d="M -4,-4 Q 14,-4 32,-4 L 32,54 L -4,54 Z"
              />
            </svg>
          </div>
        </div>
        <div className="siri-pip-eye-slot" ref={rightSlotRef}>
          <div className="siri-pip-eye-pill">
            <svg className="siri-pip-eye-svg" viewBox="0 0 28 48" width="7" height="12" aria-hidden="true">
              <path
                ref={rightPathRef}
                fill="currentColor"
                d="M -4,-4 Q 14,-4 32,-4 L 32,54 L -4,54 Z"
              />
            </svg>
          </div>
        </div>
      </div>
      <div className="siri-pip-sparkle" aria-hidden="true">
        ✦
      </div>
    </div>
  );
};
