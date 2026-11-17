import React, { useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface PipSquareEyesProps {
  active: boolean;
  onMaximize: () => void;
  onDragVisualChange: (dragging: boolean, dimmed: boolean) => void;
}

interface GazeStep {
  x: number;
  y: number;
  ms: number;
  ease: string;
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
  pendingStep: boolean;
  queuedStep: boolean;
}

const ENTER_RADIUS = 428;
const EXIT_RADIUS = 480;
const REACH_DIST = 145;
const MAX_GAZE_X = 11;
const MAX_GAZE_Y = 6.5;

const SPOT_PRESETS: Array<{ name: string; fx: number; fy: number }> = [
  { name: "Left", fx: -0.9, fy: -0.1 },
  { name: "Right", fx: 0.9, fy: -0.1 },
  { name: "Top", fx: 0, fy: -0.92 },
  { name: "UpperLeft", fx: -0.78, fy: -0.78 },
  { name: "UpperRight", fx: 0.78, fy: -0.78 },
  { name: "LowerLeft", fx: -0.72, fy: 0.74 },
  { name: "LowerRight", fx: 0.72, fy: 0.74 },
  { name: "Center", fx: 0, fy: 0 },
];

function pickRandomPresetTarget(): { x: number; y: number } {
  const jx = (Math.random() - 0.5) * 2.2;
  const jy = (Math.random() - 0.5) * 1.6;
  const pick = SPOT_PRESETS[Math.floor(Math.random() * SPOT_PRESETS.length)];
  if (pick.name === "Top") {
    return { x: jx * 2, y: MAX_GAZE_Y * pick.fy + jy * 0.5 };
  }
  if (pick.name === "Center") {
    return { x: jx * 0.8, y: jy * 0.8 };
  }
  if (pick.name === "Left" || pick.name === "Right") {
    return { x: MAX_GAZE_X * pick.fx + jx, y: MAX_GAZE_Y * pick.fy + jy };
  }
  return { x: MAX_GAZE_X * pick.fx, y: MAX_GAZE_Y * pick.fy };
}

/**
 * Pure-glass minimized PiP cartoony dot-eyes with natural blinking, random idle watching,
 * saccadic blink coupling, desktop-wide cursor proximity focus, and drag/shake dizziness.
 */
export const PipSquareEyes: React.FC<PipSquareEyesProps> = ({
  active,
  onMaximize,
  onDragVisualChange,
}) => {
  const eyesRef = useRef<HTMLDivElement>(null);
  const leftSlotRef = useRef<HTMLDivElement>(null);
  const rightSlotRef = useRef<HTMLDivElement>(null);
  const leftEyeRef = useRef<HTMLDivElement>(null);
  const rightEyeRef = useRef<HTMLDivElement>(null);

  const activeRef = useRef(active);
  activeRef.current = active;
  const onMaximizeRef = useRef(onMaximize);
  onMaximizeRef.current = onMaximize;
  const onDragVisualChangeRef = useRef(onDragVisualChange);
  onDragVisualChangeRef.current = onDragVisualChange;

  const curGazeRef = useRef({ x: 0, y: 0 });
  const prevStepVecRef = useRef({ dx: 0, dy: 0 });
  const blinkTimerRef = useRef<number | null>(null);
  const doubleBlinkTimerRef = useRef<number | null>(null);
  const gazeTimerRef = useRef<number | null>(null);
  const exitIdleTimerRef = useRef<number | null>(null);
  const saccadeBlinkTimerRef = useRef<number | null>(null);
  const scanQueueRef = useRef<GazeStep[]>([]);
  const isBlinkingRef = useRef(false);
  const isMouseNearRef = useRef(false);

  const dizzyLevelRef = useRef(0);
  const dizzyPhaseRef = useRef(0);
  const dizzyRafRef = useRef<number | null>(null);
  const dizzyLastTimeRef = useRef(0);
  const dragStateRef = useRef<DragState | null>(null);

  const resetEyeSlots = useCallback(() => {
    const leftSlot = leftSlotRef.current;
    const rightSlot = rightSlotRef.current;
    const leftEye = leftEyeRef.current;
    const rightEye = rightEyeRef.current;
    if (leftSlot) {
      leftSlot.style.setProperty("--dx", "0px");
      leftSlot.style.setProperty("--dy", "0px");
      leftSlot.style.setProperty("--dsx", "1");
      leftSlot.style.setProperty("--dsy", "1");
    }
    if (rightSlot) {
      rightSlot.style.setProperty("--dx", "0px");
      rightSlot.style.setProperty("--dy", "0px");
      rightSlot.style.setProperty("--dsx", "1");
      rightSlot.style.setProperty("--dsy", "1");
    }
    if (leftEye) leftEye.style.setProperty("--eye-op", "1");
    if (rightEye) rightEye.style.setProperty("--eye-op", "1");
  }, []);

  const performBlink = useCallback(
    (durationMs = 168, allowDouble = false, forceDouble = false) => {
      if (!activeRef.current || isBlinkingRef.current) return;
      const leftEye = leftEyeRef.current;
      const rightEye = rightEyeRef.current;
      if (!leftEye || !rightEye) return;

      isBlinkingRef.current = true;
      const keyframes: Keyframe[] = [
        { transform: "scale(1, 1)", offset: 0 },
        { transform: "scale(1.13, 0.08)", offset: 0.34 },
        { transform: "scale(1.15, 0.07)", offset: 0.48 },
        { transform: "scale(0.98, 1.05)", offset: 0.82 },
        { transform: "scale(1, 1)", offset: 1 },
      ];
      const opts: KeyframeAnimationOptions = { duration: durationMs, easing: "linear", fill: "none" };
      const animL = leftEye.animate(keyframes, opts);
      rightEye.animate(keyframes, opts);

      animL.onfinish = () => {
        isBlinkingRef.current = false;
        if ((forceDouble || (allowDouble && Math.random() < 0.14)) && activeRef.current) {
          if (doubleBlinkTimerRef.current !== null) {
            window.clearTimeout(doubleBlinkTimerRef.current);
          }
          doubleBlinkTimerRef.current = window.setTimeout(() => {
            doubleBlinkTimerRef.current = null;
            if (activeRef.current) {
              performBlink(142, false, false);
            }
          }, 125);
        }
      };
    },
    []
  );

  const scheduleNaturalBlink = useCallback(() => {
    if (blinkTimerRef.current !== null) {
      window.clearTimeout(blinkTimerRef.current);
      blinkTimerRef.current = null;
    }
    if (!activeRef.current) return;
    const delay = 2100 + Math.random() * 2300 + Math.random() * 2200;
    blinkTimerRef.current = window.setTimeout(() => {
      blinkTimerRef.current = null;
      if (activeRef.current && !dragStateRef.current?.moved && dizzyLevelRef.current < 0.08) {
        performBlink(160 + Math.round(Math.random() * 26), true, false);
      }
      scheduleNaturalBlink();
    }, delay);
  }, [performBlink]);

  const setGazeTarget = useCallback(
    (nx: number, ny: number, transitionMs: number, easingStr: string, allowBlink = true) => {
      const eyesEl = eyesRef.current;
      if (!eyesEl) return;

      const clampedX = Math.max(-MAX_GAZE_X, Math.min(MAX_GAZE_X, nx));
      const clampedY = Math.max(-MAX_GAZE_Y, Math.min(MAX_GAZE_Y, ny));

      const dx = clampedX - curGazeRef.current.x;
      const dy = clampedY - curGazeRef.current.y;
      const dist = Math.hypot(dx, dy);
      const normDist = dist / (MAX_GAZE_X * 1.45);

      const prevMag = Math.hypot(prevStepVecRef.current.dx, prevStepVecRef.current.dy);
      let isSharpReversal = false;
      if (prevMag > 1.5 && dist > 1.5) {
        const dot = (prevStepVecRef.current.dx * dx + prevStepVecRef.current.dy * dy) / (prevMag * dist);
        isSharpReversal = dot <= -0.35;
      }

      let didBlink = false;
      if (allowBlink && transitionMs < 240) {
        if (normDist >= 0.72 || (isSharpReversal && normDist >= 0.56)) {
          didBlink = true;
        } else if (normDist >= 0.48 && Math.random() < 0.65) {
          didBlink = true;
        }
      }

      prevStepVecRef.current = { dx, dy };
      curGazeRef.current = { x: clampedX, y: clampedY };
      eyesEl.style.setProperty("--gaze-ms", `${transitionMs}ms`);
      eyesEl.style.setProperty("--gaze-ease", easingStr);
      eyesEl.style.setProperty("--gx", `${clampedX.toFixed(2)}px`);
      eyesEl.style.setProperty("--gy", `${clampedY.toFixed(2)}px`);

      if (didBlink) {
        scheduleNaturalBlink();
        if (saccadeBlinkTimerRef.current !== null) {
          window.clearTimeout(saccadeBlinkTimerRef.current);
        }
        saccadeBlinkTimerRef.current = window.setTimeout(() => {
          saccadeBlinkTimerRef.current = null;
          performBlink(152, false, false);
        }, 12);
      }
    },
    [performBlink, scheduleNaturalBlink]
  );

  const scheduleNextGaze = useCallback(() => {
    if (gazeTimerRef.current !== null) {
      window.clearTimeout(gazeTimerRef.current);
      gazeTimerRef.current = null;
    }
    if (
      !activeRef.current ||
      isMouseNearRef.current ||
      dragStateRef.current?.moved ||
      dizzyLevelRef.current > 0.04
    ) {
      return;
    }

    if (scanQueueRef.current.length > 0) {
      const nextStep = scanQueueRef.current.shift()!;
      setGazeTarget(nextStep.x, nextStep.y, nextStep.ms, nextStep.ease);
      gazeTimerRef.current = window.setTimeout(
        scheduleNextGaze,
        nextStep.ease.includes("0.25") ? 1150 : 540 + Math.round(Math.random() * 140)
      );
      return;
    }

    const roll = Math.random();
    if (roll < 0.28) {
      const angle = Math.random() * Math.PI * 2;
      const stepLen = 2.8 + Math.random() * (MAX_GAZE_X * 0.36);
      const nx = curGazeRef.current.x + Math.cos(angle) * stepLen;
      const ny = curGazeRef.current.y + Math.sin(angle) * (stepLen * 0.65);
      setGazeTarget(
        nx,
        ny,
        380 + Math.round(Math.random() * 180),
        "cubic-bezier(0.35, 0, 0.25, 1)"
      );
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 1100 + Math.random() * 1400);
    } else if (roll < 0.58) {
      if (Math.random() < 0.5) {
        scanQueueRef.current = [
          { x: -MAX_GAZE_X * 0.92, y: 0, ms: 105, ease: "cubic-bezier(0.22, 1, 0.36, 1)" },
          { x: MAX_GAZE_X * 0.92, y: -MAX_GAZE_Y * 0.15, ms: 115, ease: "cubic-bezier(0.22, 1, 0.36, 1)" },
          { x: 0, y: -MAX_GAZE_Y * 0.9, ms: 110, ease: "cubic-bezier(0.22, 1, 0.36, 1)" },
          { x: 0, y: 0, ms: 340, ease: "cubic-bezier(0.25, 0.1, 0.25, 1)" },
        ];
      } else {
        const p1 = pickRandomPresetTarget();
        const p2 = pickRandomPresetTarget();
        scanQueueRef.current = [
          { x: p1.x, y: p1.y, ms: 110, ease: "cubic-bezier(0.22, 1, 0.36, 1)" },
          { x: p2.x, y: p2.y, ms: 115, ease: "cubic-bezier(0.22, 1, 0.36, 1)" },
          { x: (Math.random() - 0.5) * 3, y: 0, ms: 320, ease: "cubic-bezier(0.25, 0.1, 0.25, 1)" },
        ];
      }
      scheduleNextGaze();
    } else {
      const spot = pickRandomPresetTarget();
      setGazeTarget(spot.x, spot.y, 95 + Math.round(Math.random() * 45), "cubic-bezier(0.22, 1, 0.36, 1)");
      gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 850 + Math.random() * 1900);
    }
  }, [setGazeTarget]);

  const updateProximityDelta = useCallback(
    (dx: number, dy: number, forceRefresh = false) => {
      if (!activeRef.current || dragStateRef.current?.moved || dizzyLevelRef.current > 0.04) {
        return;
      }

      const dist = Math.hypot(dx, dy);
      const within = isMouseNearRef.current ? dist <= EXIT_RADIUS : dist <= ENTER_RADIUS;

      if (within) {
        if (exitIdleTimerRef.current !== null) {
          window.clearTimeout(exitIdleTimerRef.current);
          exitIdleTimerRef.current = null;
        }
        const justEntered = !isMouseNearRef.current;
        if (justEntered) {
          isMouseNearRef.current = true;
          if (gazeTimerRef.current !== null) {
            window.clearTimeout(gazeTimerRef.current);
            gazeTimerRef.current = null;
          }
          scanQueueRef.current = [];
        }

        const reach = Math.min(1, dist / REACH_DIST);
        const nx = dist < 4 ? 0 : (dx / dist) * MAX_GAZE_X * reach;
        const ny = dist < 4 ? 0 : (dy / dist) * MAX_GAZE_Y * reach;

        setGazeTarget(
          nx,
          ny,
          justEntered || forceRefresh ? 110 : 50,
          justEntered || forceRefresh ? "cubic-bezier(0.22, 1, 0.36, 1)" : "ease-out",
          justEntered
        );
      } else if (isMouseNearRef.current || forceRefresh) {
        isMouseNearRef.current = false;
        if (exitIdleTimerRef.current !== null) {
          window.clearTimeout(exitIdleTimerRef.current);
        }
        if (gazeTimerRef.current !== null) {
          window.clearTimeout(gazeTimerRef.current);
          gazeTimerRef.current = null;
        }
        exitIdleTimerRef.current = window.setTimeout(() => {
          exitIdleTimerRef.current = null;
          if (
            activeRef.current &&
            !isMouseNearRef.current &&
            !dragStateRef.current?.moved &&
            dizzyLevelRef.current <= 0.02
          ) {
            gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 520);
          }
        }, 380);
      }
    },
    [scheduleNextGaze, setGazeTarget]
  );

  const stepDizzy = useCallback(
    (now: number) => {
      if (!activeRef.current) {
        dizzyRafRef.current = null;
        return;
      }

      const dtSec = Math.min(0.05, Math.max(0.004, (now - dizzyLastTimeRef.current) / 1000));
      dizzyLastTimeRef.current = now;

      if (!dragStateRef.current?.moved) {
        // Tuned recovery decay (~0.51s light drag, ~0.73s full shake)
        dizzyLevelRef.current *= Math.pow(0.0068, dtSec);
      }

      if (dizzyLevelRef.current <= 0.025 && !dragStateRef.current?.moved) {
        dizzyLevelRef.current = 0;
        dizzyRafRef.current = null;
        resetEyeSlots();
        onDragVisualChangeRef.current(false, false);
        performBlink(145, false, true);
        scheduleNaturalBlink();

        if (exitIdleTimerRef.current !== null) {
          window.clearTimeout(exitIdleTimerRef.current);
        }
        exitIdleTimerRef.current = window.setTimeout(() => {
          exitIdleTimerRef.current = null;
          if (!activeRef.current || dragStateRef.current?.moved) return;
          invoke<{ dx?: number; dy?: number }>("get_pip_cursor_delta")
            .then((res) => {
              if (typeof res?.dx === "number" && typeof res?.dy === "number") {
                updateProximityDelta(res.dx, res.dy, true);
              }
            })
            .catch(() => {});
        }, 280);
        return;
      }

      onDragVisualChangeRef.current(Boolean(dragStateRef.current?.moved), true);
      dizzyPhaseRef.current += dtSec * (10.5 + dizzyLevelRef.current * 16.5);

      const ampX = 1.6 + dizzyLevelRef.current * 3.8;
      const ampY = 1.1 + dizzyLevelRef.current * 3.1;
      const crossEye = dizzyLevelRef.current * 1.4;

      const p = dizzyPhaseRef.current;
      const ldx = Math.cos(p) * ampX + crossEye;
      const ldy = Math.sin(p * 1.32) * ampY;
      const rdx = -Math.cos(p + 0.85) * ampX - crossEye;
      const rdy = -Math.sin(p * 1.32 + 0.65) * ampY;

      const lsy = Math.max(0.46, 1 - dizzyLevelRef.current * 0.24 + Math.sin(p * 1.6) * dizzyLevelRef.current * 0.26);
      const rsy = Math.max(0.46, 1 - dizzyLevelRef.current * 0.24 - Math.sin(p * 1.6 + 0.5) * dizzyLevelRef.current * 0.26);
      const lsx = 1 + (1 - lsy) * 0.35;
      const rsx = 1 + (1 - rsy) * 0.35;
      const dimOp = (1 - 0.30 - dizzyLevelRef.current * 0.28).toFixed(2);

      const leftSlot = leftSlotRef.current;
      const rightSlot = rightSlotRef.current;
      const leftEye = leftEyeRef.current;
      const rightEye = rightEyeRef.current;

      if (leftSlot) {
        leftSlot.style.setProperty("--dx", `${ldx.toFixed(2)}px`);
        leftSlot.style.setProperty("--dy", `${ldy.toFixed(2)}px`);
        leftSlot.style.setProperty("--dsx", lsx.toFixed(3));
        leftSlot.style.setProperty("--dsy", lsy.toFixed(3));
      }
      if (rightSlot) {
        rightSlot.style.setProperty("--dx", `${rdx.toFixed(2)}px`);
        rightSlot.style.setProperty("--dy", `${rdy.toFixed(2)}px`);
        rightSlot.style.setProperty("--dsx", rsx.toFixed(3));
        rightSlot.style.setProperty("--dsy", rsy.toFixed(3));
      }
      if (leftEye) leftEye.style.setProperty("--eye-op", dimOp);
      if (rightEye) rightEye.style.setProperty("--eye-op", dimOp);

      dizzyRafRef.current = requestAnimationFrame(stepDizzy);
    },
    [performBlink, resetEyeSlots, scheduleNaturalBlink, updateProximityDelta]
  );

  const boostDizzy = useCallback(
    (targetLevel: number) => {
      dizzyLevelRef.current = Math.min(1, Math.max(dizzyLevelRef.current, targetLevel));
      if (dizzyRafRef.current === null) {
        dizzyLastTimeRef.current = performance.now();
        dizzyRafRef.current = requestAnimationFrame(stepDizzy);
      }
    },
    [stepDizzy]
  );

  const stopEyeLife = useCallback(() => {
    if (blinkTimerRef.current !== null) {
      window.clearTimeout(blinkTimerRef.current);
      blinkTimerRef.current = null;
    }
    if (doubleBlinkTimerRef.current !== null) {
      window.clearTimeout(doubleBlinkTimerRef.current);
      doubleBlinkTimerRef.current = null;
    }
    if (gazeTimerRef.current !== null) {
      window.clearTimeout(gazeTimerRef.current);
      gazeTimerRef.current = null;
    }
    if (exitIdleTimerRef.current !== null) {
      window.clearTimeout(exitIdleTimerRef.current);
      exitIdleTimerRef.current = null;
    }
    if (saccadeBlinkTimerRef.current !== null) {
      window.clearTimeout(saccadeBlinkTimerRef.current);
      saccadeBlinkTimerRef.current = null;
    }
    if (dizzyRafRef.current !== null) {
      cancelAnimationFrame(dizzyRafRef.current);
      dizzyRafRef.current = null;
    }
    dizzyLevelRef.current = 0;
    isBlinkingRef.current = false;
    isMouseNearRef.current = false;
    scanQueueRef.current = [];
    curGazeRef.current = { x: 0, y: 0 };
    prevStepVecRef.current = { dx: 0, dy: 0 };
    dragStateRef.current = null;
    resetEyeSlots();
    if (eyesRef.current) {
      eyesRef.current.style.setProperty("--gaze-ms", "120ms");
      eyesRef.current.style.setProperty("--gx", "0px");
      eyesRef.current.style.setProperty("--gy", "0px");
    }
    onDragVisualChangeRef.current(false, false);
  }, [resetEyeSlots]);

  useEffect(() => {
    if (!active) {
      stopEyeLife();
      return;
    }

    stopEyeLife();
    scheduleNaturalBlink();
    gazeTimerRef.current = window.setTimeout(scheduleNextGaze, 650);

    let unlistenCursor: (() => void) | undefined;
    let disposed = false;

    listen<{ dx: number; dy: number }>("pip-cursor-update", (event) => {
      if (!disposed && event.payload) {
        updateProximityDelta(event.payload.dx, event.payload.dy);
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

    return () => {
      disposed = true;
      if (unlistenCursor) unlistenCursor();
      stopEyeLife();
    };
  }, [active, scheduleNaturalBlink, scheduleNextGaze, stopEyeLife, updateProximityDelta]);

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
      isMouseNearRef.current = false;
      if (exitIdleTimerRef.current !== null) {
        window.clearTimeout(exitIdleTimerRef.current);
        exitIdleTimerRef.current = null;
      }
      if (gazeTimerRef.current !== null) {
        window.clearTimeout(gazeTimerRef.current);
        gazeTimerRef.current = null;
      }
      scanQueueRef.current = [];
      onDragVisualChangeRef.current(true, true);
      boostDizzy(0.32);
    }

    if (ds.moved) {
      flushNativeDragStep(ds);

      const dt = Math.max(8, now - ds.prevTime);
      const vx = (e.screenX - ds.prevScreenX) / dt;
      const vy = (e.screenY - ds.prevScreenY) / dt;
      const speed = Math.hypot(vx, vy);

      // Opposite-velocity gaze inertia lag during drag
      if (eyesRef.current) {
        const lagX = Math.max(-MAX_GAZE_X, Math.min(MAX_GAZE_X, -vx * 7.5));
        const lagY = Math.max(-MAX_GAZE_Y, Math.min(MAX_GAZE_Y, -vy * 7.5));
        eyesRef.current.style.setProperty("--gaze-ms", "75ms");
        eyesRef.current.style.setProperty("--gaze-ease", "ease-out");
        eyesRef.current.style.setProperty("--gx", `${lagX.toFixed(2)}px`);
        eyesRef.current.style.setProperty("--gy", `${lagY.toFixed(2)}px`);
        curGazeRef.current = { x: lagX, y: lagY };
      }

      // Detect rapid jerks and back-and-forth shaking
      const prevSpd = Math.hypot(ds.prevVx, ds.prevVy);
      let reversalBoost = 0;
      if (prevSpd > 0.28 && speed > 0.28) {
        const dot = (ds.prevVx * vx + ds.prevVy * vy) / (prevSpd * speed);
        if (dot < -0.22) {
          reversalBoost = Math.min(0.42, (speed + prevSpd) * 0.19);
        }
      }
      const speedBoost = speed > 0.55 ? Math.min(0.18, (speed - 0.55) * 0.14) : 0.02;
      boostDizzy(Math.max(0.32, dizzyLevelRef.current) + reversalBoost + speedBoost);

      ds.prevScreenX = e.screenX;
      ds.prevScreenY = e.screenY;
      ds.prevTime = now;
      ds.prevVx = vx;
      ds.prevVy = vy;
    }
  };

  const finishInteraction = (e: React.PointerEvent<HTMLDivElement>, isCancel: boolean) => {
    const ds = dragStateRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    const wasDrag = ds.moved;
    dragStateRef.current = null;

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }

    invoke("end_pip_drag").catch(() => {});

    if (wasDrag || isCancel) {
      onDragVisualChangeRef.current(false, dizzyLevelRef.current > 0.025);
      if (eyesRef.current) {
        eyesRef.current.style.setProperty("--gaze-ms", "220ms");
        eyesRef.current.style.setProperty("--gx", "0px");
        eyesRef.current.style.setProperty("--gy", "0px");
      }
      curGazeRef.current = { x: 0, y: 0 };
      return;
    }

    if (active) {
      onMaximizeRef.current();
    }
  };

  return (
    <div
      className="siri-pip-content"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => finishInteraction(e, false)}
      onPointerCancel={(e) => finishInteraction(e, true)}
      onLostPointerCapture={(e) => finishInteraction(e, true)}
      title="Drag anywhere • Click to restore • Esc to sleep"
    >
      <div className="siri-pip-eyes" ref={eyesRef} aria-hidden="true">
        <div className="siri-pip-eye-slot" ref={leftSlotRef}>
          <div className="siri-pip-eye" ref={leftEyeRef} />
        </div>
        <div className="siri-pip-eye-slot" ref={rightSlotRef}>
          <div className="siri-pip-eye" ref={rightEyeRef} />
        </div>
      </div>
    </div>
  );
};
