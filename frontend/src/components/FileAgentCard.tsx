import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./FileAgentCard.css";

export interface FileAgentTreeNode {
  id: string;
  label: string;
  state: "idle" | "scan" | "zero" | "dead" | "found" | "halt";
  matchedFile?: string | null;
}

export interface FileAgentTreeEdge {
  from: string;
  to: string;
  state: "idle" | "scan" | "zero" | "dead" | "found" | "halt";
}

export interface FileAgentJobState {
  jobId: string;
  goal: string;
  status: "scan" | "found" | "dead" | "stopped";
  activeAgents: number;
  foundPath: string;
  foundName: string;
  nearMiss?: { name: string; path: string } | null;
  barTitle: string;
  barPath: string;
  columns: FileAgentTreeNode[][];
  edges: FileAgentTreeEdge[];
  anchorTurnId?: string | null;
}

interface FileAgentCardProps {
  job: FileAgentJobState;
  onStop: (jobId: string) => void;
  onOpenPath: (path: string, mode: "open" | "reveal") => void;
  onLayoutChange?: () => void;
}

interface ComputedEdgeGeom {
  key: string;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  state: string;
}

const PAD_X = 14;
const PAD_TOP = 10;
const PAD_BOT = 12;
const MIN_CANVAS_H = 246;
const MAX_CANVAS_H = 344;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.35;
const RUBBER_FACTOR = 0.28;
const MAX_OVERSHOOT = 72;

function getLocalBox(el: HTMLElement, ancestor: HTMLElement) {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== ancestor) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function applyElasticResistance(val: number, minV: number, maxV: number): number {
  if (val < minV) {
    const over = minV - val;
    const damped = MAX_OVERSHOOT * (1 - Math.exp((-over * RUBBER_FACTOR) / MAX_OVERSHOOT));
    return minV - damped;
  }
  if (val > maxV) {
    const over = val - maxV;
    const damped = MAX_OVERSHOOT * (1 - Math.exp((-over * RUBBER_FACTOR) / MAX_OVERSHOOT));
    return maxV + damped;
  }
  return val;
}

export const FileAgentCard: React.FC<FileAgentCardProps> = ({
  job,
  onStop,
  onOpenPath,
  onLayoutChange,
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const zoomPillRef = useRef<HTMLDivElement>(null);
  const zoomSliderRef = useRef<HTMLInputElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);

  const [zoom, setZoom] = useState<number>(1.0);
  const zoomRef = useRef<number>(1.0);
  const [isSlidingZoom, setIsSlidingZoom] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [canvasH, setCanvasH] = useState<number>(MIN_CANVAS_H);
  const [canPanFreely, setCanPanFreely] = useState<boolean>(false);
  const [svgSize, setSvgSize] = useState<{ w: number; h: number }>({ w: 400, h: 200 });
  const [edgeGeoms, setEdgeGeoms] = useState<ComputedEdgeGeom[]>([]);
  const [openFeedback, setOpenFeedback] = useState<"idle" | "opened">("idle");
  const [folderFeedback, setFolderFeedback] = useState<"idle" | "shown">("idle");

  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const boundsRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number }>({
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
  });
  const dragStateRef = useRef<{
    active: boolean;
    startMouseX: number;
    startMouseY: number;
    originPanX: number;
    originPanY: number;
  }>({ active: false, startMouseX: 0, startMouseY: 0, originPanX: 0, originPanY: 0 });
  const wheelGravityTimerRef = useRef<number | null>(null);
  const prevNodeCountRef = useRef<number>(0);

  const applyWorldTransform = useCallback((withSpring: boolean) => {
    const world = worldRef.current;
    const canvas = canvasRef.current;
    if (!world || !canvas) return;
    world.classList.toggle("spring-back", withSpring);
    const z = zoomRef.current;
    const px = panRef.current.x;
    const py = panRef.current.y;
    world.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) scale(${z.toFixed(3)})`;
    const gridStep = Math.max(9, Math.min(22, 14 * z));
    canvas.style.backgroundSize = `${gridStep.toFixed(1)}px ${gridStep.toFixed(1)}px`;
    canvas.style.backgroundPosition = `${(px * 0.55).toFixed(1)}px ${(py * 0.55).toFixed(1)}px`;
  }, []);

  const clampAndGravitate = useCallback(() => {
    const b = boundsRef.current;
    panRef.current.x = Math.max(b.minX, Math.min(b.maxX, panRef.current.x));
    panRef.current.y = Math.max(b.minY, Math.min(b.maxY, panRef.current.y));
    applyWorldTransform(true);
  }, [applyWorldTransform]);

  const recomputeBounds = useCallback(
    (autoFocusRight: boolean) => {
      const canvas = canvasRef.current;
      const world = worldRef.current;
      if (!canvas || !world) return;

      const vpW = canvas.clientWidth || 424;
      const z = zoomRef.current;
      const natW = world.offsetWidth * z;
      const natH = world.offsetHeight * z;

      const targetH = Math.max(MIN_CANVAS_H, Math.min(MAX_CANVAS_H, Math.ceil(natH + 22)));
      setCanvasH(targetH);

      const nextBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
      if (natW <= vpW) {
        const cx = (vpW - natW) / 2;
        nextBounds.minX = cx;
        nextBounds.maxX = cx;
      } else {
        nextBounds.minX = vpW - natW - PAD_X;
        nextBounds.maxX = PAD_X;
      }

      if (natH <= targetH) {
        const cy = (targetH - natH) / 2;
        nextBounds.minY = cy;
        nextBounds.maxY = cy;
      } else {
        nextBounds.minY = targetH - natH - PAD_BOT;
        nextBounds.maxY = PAD_TOP;
      }

      boundsRef.current = nextBounds;
      setCanPanFreely(natW > vpW || natH > targetH);

      if (autoFocusRight) {
        panRef.current.x = nextBounds.minX;
        panRef.current.y = (nextBounds.minY + nextBounds.maxY) / 2;
        applyWorldTransform(true);
      } else {
        clampAndGravitate();
      }

      if (onLayoutChange) {
        onLayoutChange();
      }
    },
    [applyWorldTransform, clampAndGravitate, onLayoutChange]
  );

  // Re-measure layout-accurate SVG Bezier edges & bounds whenever tree columns/edges update
  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world) return;

    const rafId = window.requestAnimationFrame(() => {
      const w = world.offsetWidth;
      const h = world.offsetHeight;
      setSvgSize({ w, h });

      const geoms: ComputedEdgeGeom[] = [];
      for (const edge of job.edges) {
        const a = world.querySelector(`[data-node-id="${edge.from}"]`) as HTMLElement | null;
        const b = world.querySelector(`[data-node-id="${edge.to}"]`) as HTMLElement | null;
        if (!a || !b) continue;
        const ar = getLocalBox(a, world);
        const br = getLocalBox(b, world);
        const x1 = ar.x + ar.w;
        const y1 = ar.y + ar.h / 2;
        const x2 = br.x;
        const y2 = br.y + br.h / 2;
        const dx = Math.max(11, (x2 - x1) * 0.52);
        const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
        geoms.push({
          key: `${edge.from}->${edge.to}`,
          d,
          x1,
          y1,
          x2,
          y2,
          state: edge.state || "scan",
        });
      }
      setEdgeGeoms(geoms);

      const nodeCount = job.columns.reduce((acc, col) => acc + col.length, 0);
      const grew = nodeCount !== prevNodeCountRef.current;
      prevNodeCountRef.current = nodeCount;
      recomputeBounds(grew || job.status === "found");
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [job.columns, job.edges, job.status, recomputeBounds]);

  const setZoomLevel = useCallback(
    (nextZoomRaw: number, smooth: boolean) => {
      const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(nextZoomRaw)));
      const prevZoom = zoomRef.current;
      if (Math.abs(clamped - prevZoom) < 0.001) return;

      const canvas = canvasRef.current;
      const vpW = canvas?.clientWidth || 424;
      const vpH = canvas?.clientHeight || MIN_CANVAS_H;
      const cx = vpW / 2;
      const cy = vpH / 2;
      const worldCenterX = (cx - panRef.current.x) / prevZoom;
      const worldCenterY = (cy - panRef.current.y) / prevZoom;

      zoomRef.current = clamped;
      setZoom(clamped);
      panRef.current.x = cx - worldCenterX * clamped;
      panRef.current.y = cy - worldCenterY * clamped;

      recomputeBounds(false);
      if (!smooth) {
        applyWorldTransform(false);
      }
    },
    [applyWorldTransform, recomputeBounds]
  );

  const releaseZoomFocus = useCallback(() => {
    zoomSliderRef.current?.blur();
    zoomOutRef.current?.blur();
    zoomInRef.current?.blur();
  }, []);

  useEffect(() => {
    const onWinUp = () => {
      if (isSlidingZoom) {
        setIsSlidingZoom(false);
        releaseZoomFocus();
      }
    };
    window.addEventListener("pointerup", onWinUp);
    window.addEventListener("pointercancel", onWinUp);
    return () => {
      window.removeEventListener("pointerup", onWinUp);
      window.removeEventListener("pointercancel", onWinUp);
      if (wheelGravityTimerRef.current !== null) {
        window.clearTimeout(wheelGravityTimerRef.current);
      }
    };
  }, [isSlidingZoom, releaseZoomFocus]);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input, .fa-zoom-pill")) return;
    dragStateRef.current = {
      active: true,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      originPanX: panRef.current.x,
      originPanY: panRef.current.y,
    };
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    worldRef.current?.classList.remove("spring-back");
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current.active) return;
    const rawX = dragStateRef.current.originPanX + (e.clientX - dragStateRef.current.startMouseX);
    const rawY = dragStateRef.current.originPanY + (e.clientY - dragStateRef.current.startMouseY);
    const b = boundsRef.current;
    panRef.current.x = applyElasticResistance(rawX, b.minX, b.maxX);
    panRef.current.y = applyElasticResistance(rawY, b.minY, b.maxY);
    applyWorldTransform(false);
  };

  const handleCanvasPointerEnd = () => {
    if (!dragStateRef.current.active) return;
    dragStateRef.current.active = false;
    setIsDragging(false);
    clampAndGravitate();
  };

  const handleCanvasWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Allow horizontal trackpad pan inside canvas; let vertical wheel scroll the chat stream unless shift-held
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.stopPropagation();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const b = boundsRef.current;
      panRef.current.x = applyElasticResistance(panRef.current.x - delta * 0.65, b.minX, b.maxX);
      applyWorldTransform(false);
      if (wheelGravityTimerRef.current !== null) {
        window.clearTimeout(wheelGravityTimerRef.current);
      }
      wheelGravityTimerRef.current = window.setTimeout(clampAndGravitate, 140);
    }
  };

  const agentLabel =
    job.status === "scan"
      ? `${Math.max(1, job.activeAgents)} ${Math.max(1, job.activeAgents) === 1 ? "agent" : "agents"} active`
      : job.status === "found"
      ? "Found · 0 active"
      : job.status === "stopped"
      ? "Stopped · 0 active"
      : "Dead end · 0 active";

  const actionTargetPath = job.foundPath || job.nearMiss?.path || "";
  const canOpen = Boolean(actionTargetPath && (job.status === "found" || (job.status === "dead" && job.nearMiss)));

  return (
    <section className="fa-card" aria-label="File Explorer Swarm">
      {/* Headerless Dotted Canvas with Floating Opaque Grey Pills */}
      <div
        ref={canvasRef}
        className={`fa-canvas ${isDragging ? "dragging" : ""}`}
        style={{ height: `${canvasH}px` }}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerEnd}
        onPointerCancel={handleCanvasPointerEnd}
        onWheel={handleCanvasWheel}
      >
        <div className="fa-top-left-cluster">
          <div className="fa-float-pill fa-float-status">
            <span className={`fa-live-dot ${job.status}`} />
            <span>{agentLabel}</span>
          </div>

          <div
            ref={zoomPillRef}
            className={`fa-float-pill fa-zoom-pill ${isSlidingZoom ? "is-sliding" : ""}`}
            aria-label="Canvas zoom"
            onPointerLeave={() => {
              if (!isSlidingZoom) {
                releaseZoomFocus();
              }
            }}
          >
            <button
              ref={zoomOutRef}
              type="button"
              className="fa-zoom-step"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={(e) => {
                e.stopPropagation();
                setZoomLevel(zoomRef.current - 0.15, true);
                zoomOutRef.current?.blur();
              }}
            >
              −
            </button>
            <input
              ref={zoomSliderRef}
              type="range"
              className="fa-zoom-range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              aria-label="Zoom level"
              onPointerDown={(e) => {
                e.stopPropagation();
                setIsSlidingZoom(true);
              }}
              onChange={(e) => setZoomLevel(parseFloat(e.target.value), false)}
            />
            <button
              ref={zoomInRef}
              type="button"
              className="fa-zoom-step"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={(e) => {
                e.stopPropagation();
                setZoomLevel(zoomRef.current + 0.15, true);
                zoomInRef.current?.blur();
              }}
            >
              +
            </button>
          </div>
        </div>

        <button
          type="button"
          className={`fa-float-right ${job.status !== "scan" ? "is-hidden" : ""}`}
          title="Stop File Explorer agents"
          onClick={(e) => {
            e.stopPropagation();
            onStop(job.jobId);
          }}
        >
          Stop
        </button>

        <div ref={worldRef} className="fa-world">
          <svg
            className="fa-svg"
            viewBox={`0 0 ${svgSize.w} ${svgSize.h}`}
            width={svgSize.w}
            height={svgSize.h}
            aria-hidden="true"
          >
            {edgeGeoms.map((eg) => (
              <React.Fragment key={eg.key}>
                <path className={`fa-edge ${eg.state}`} d={eg.d} />
                <circle className={`fa-dot ${eg.state}`} cx={eg.x1} cy={eg.y1} r={2.2} />
                <circle className={`fa-dot ${eg.state}`} cx={eg.x2} cy={eg.y2} r={2.2} />
              </React.Fragment>
            ))}
          </svg>

          {job.columns.map((col, colIdx) => (
            <div key={`col-${colIdx}`} className="fa-col">
              {col.map((node) => {
                const isMatchLeaf = Boolean(node.matchedFile);
                return (
                  <div
                    key={node.id}
                    data-node-id={node.id}
                    className={`fa-fpill ${isMatchLeaf ? "match-card" : node.state}`}
                  >
                    {isMatchLeaf ? (
                      <>
                        <div className="fa-fpill-dir-head">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                          <span>{node.label}</span>
                        </div>
                        <div className="fa-fpill-file-chip">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          <span>{node.matchedFile}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        {node.state === "dead" ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        ) : (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                        )}
                        <span>{node.label}</span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <span className="fa-drag-hint">
          {canPanFreely ? "Drag to explore · elastic edges" : "Drag to peek · springs back"}
        </span>
      </div>

      {/* Clean Neutral Integrated Bottom Bar (NO green glow) */}
      <footer className="fa-bottom-bar">
        <div className="fa-bar-path-wrap">
          <div className="fa-bar-filename" title={job.barTitle}>
            {job.barTitle}
          </div>
          <div className="fa-bar-path" title={job.barPath}>
            {job.barPath}
          </div>
        </div>
        <div className="fa-bar-actions">
          <button
            type="button"
            className="fa-bar-btn"
            disabled={!canOpen}
            onClick={(e) => {
              e.stopPropagation();
              if (!actionTargetPath) return;
              onOpenPath(actionTargetPath, "open");
              setOpenFeedback("opened");
              window.setTimeout(() => setOpenFeedback("idle"), 1400);
            }}
          >
            {openFeedback === "opened" ? "Opened ✓" : "Open"}
          </button>
          <button
            type="button"
            className="fa-bar-btn"
            disabled={!canOpen}
            onClick={(e) => {
              e.stopPropagation();
              if (!actionTargetPath) return;
              onOpenPath(actionTargetPath, "reveal");
              setFolderFeedback("shown");
              window.setTimeout(() => setFolderFeedback("idle"), 1400);
            }}
          >
            {folderFeedback === "shown" ? "Shown ✓" : "Open in Folder"}
          </button>
        </div>
      </footer>
    </section>
  );
};
