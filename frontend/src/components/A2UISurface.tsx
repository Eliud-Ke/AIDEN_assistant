import React, { useMemo, useState, useCallback, useEffect } from "react";
import "./A2UISurface.css";

export interface A2UIComponentNode {
  id: string;
  component: string;
  props?: Record<string, any>;
  children?: string[];
}

export interface A2UIComputedSpec {
  expr: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
}

export interface A2UISurfacePayload {
  version?: string;
  createSurface?: {
    surfaceId: string;
    catalogId?: string;
  };
  updateDataModel?: {
    surfaceId?: string;
    data?: Record<string, any>;
  };
  updateComponents?: {
    surfaceId?: string;
    rootId?: string;
    components?: A2UIComponentNode[];
  };
  computed?: Record<string, A2UIComputedSpec | string>;
}

export interface A2UIActionEvent {
  surfaceId: string;
  actionId: string;
  sourceComponentId: string;
  label?: string;
  context: Record<string, any>;
}

interface A2UISurfaceProps {
  surface: A2UISurfacePayload;
  onAction?: (event: A2UIActionEvent) => void;
  onPrefillInput?: (text: string) => void;
  onLayoutChange?: () => void;
}

const ALLOWED_CATALOG = new Set([
  "Card",
  "Column",
  "Row",
  "Text",
  "Badge",
  "Divider",
  "Button",
  "TextField",
  "CheckBox",
  "ChoiceChips",
  "Slider",
  "Tabs",
  "Metric",
  "Progress",
  "ListItem",
]);

const MAX_NODES = 40;
const MAX_DEPTH = 7;

// =============================================================================
// JSON POINTER (RFC 6901) HELPERS
// =============================================================================
function getPointerValue(obj: Record<string, any>, pointer?: string): any {
  if (!pointer || typeof pointer !== "string") return undefined;
  const clean = pointer.replace(/^\//, "");
  if (!clean) return obj;
  if (Object.prototype.hasOwnProperty.call(obj, clean)) {
    return obj[clean];
  }
  const parts = clean.split("/").filter(Boolean);
  let cur: any = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPointerImmutable(
  obj: Record<string, any>,
  pointer: string,
  value: any
): Record<string, any> {
  const parts = pointer.replace(/^\//, "").split("/").filter(Boolean);
  if (parts.length === 0) return obj;
  const root: Record<string, any> = { ...obj };
  let cur: Record<string, any> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    cur[p] = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

// =============================================================================
// SAFE ZERO-EVAL REACTIVE FORMULA EVALUATOR (60fps local calculators & checklists)
// Supports +, -, *, /, %, parentheses, identifiers, numbers, strings, and
// round, floor, ceil, abs, min, max, pow, clamp, countTrue, countKeys, pctTrue.
// =============================================================================
type ExprToken =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "id"; value: string }
  | { type: "op"; value: string }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma" };

function tokenizeExpr(expr: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  const len = expr.length;
  while (i < len) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let s = "";
      i++;
      while (i < len && expr[i] !== quote) {
        s += expr[i++];
      }
      if (i < len) i++;
      tokens.push({ type: "str", value: s });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let numStr = "";
      while (i < len && /[0-9.]/.test(expr[i])) {
        numStr += expr[i++];
      }
      const parsed = parseFloat(numStr);
      tokens.push({ type: "num", value: Number.isFinite(parsed) ? parsed : 0 });
      continue;
    }
    if (/[a-zA-Z_/]/.test(ch)) {
      let id = "";
      while (i < len && /[a-zA-Z0-9_./-]/.test(expr[i])) {
        id += expr[i++];
      }
      tokens.push({ type: "id", value: id });
      continue;
    }
    i++;
  }
  return tokens;
}

function collectBooleans(model: Record<string, any>, prefix?: string): boolean[] {
  const out: boolean[] = [];
  for (const [k, v] of Object.entries(model)) {
    if (typeof v !== "boolean") continue;
    if (prefix && !k.startsWith(prefix)) continue;
    out.push(v);
  }
  return out;
}

function evaluateSafeFormula(expr: string, model: Record<string, any>): number {
  const tokens = tokenizeExpr(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (peek()?.type === "op" && (peek() as any).value in { "+": 1, "-": 1 }) {
      const op = (consume() as { type: "op"; value: string }).value;
      const right = parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv(): number {
    let left = parseUnary();
    while (peek()?.type === "op" && ((peek() as any).value === "*" || (peek() as any).value === "/" || (peek() as any).value === "%")) {
      const op = (consume() as { type: "op"; value: string }).value;
      const right = parseUnary();
      if (op === "*") left *= right;
      else if (op === "/") left = right === 0 ? 0 : left / right;
      else left = right === 0 ? 0 : left % right;
    }
    return left;
  }

  function parseUnary(): number {
    const t = peek();
    if (t?.type === "op" && (t.value === "-" || t.value === "+")) {
      consume();
      const val = parseUnary();
      return t.value === "-" ? -val : val;
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) return 0;

    if (t.type === "num") {
      consume();
      return t.value;
    }
    if (t.type === "paren" && t.value === "(") {
      consume();
      const val = parseAddSub();
      if (peek()?.type === "paren" && (peek() as any).value === ")") {
        consume();
      }
      return val;
    }
    if (t.type === "id") {
      consume();
      const name = t.value;
      // Function call?
      if (peek()?.type === "paren" && (peek() as any).value === "(") {
        consume();
        const args: Array<number | string> = [];
        while (peek() && !(peek()?.type === "paren" && (peek() as any).value === ")")) {
          if (peek()?.type === "str") {
            args.push((consume() as { type: "str"; value: string }).value);
          } else {
            args.push(parseAddSub());
          }
          if (peek()?.type === "comma") consume();
        }
        if (peek()?.type === "paren" && (peek() as any).value === ")") {
          consume();
        }
        const nums = args.map((a) => (typeof a === "number" ? a : parseFloat(a) || 0));
        const strArg = typeof args[0] === "string" ? args[0] : undefined;
        switch (name) {
          case "round": {
            const d = nums.length > 1 ? Math.max(0, Math.min(6, Math.round(nums[1]))) : 0;
            const factor = Math.pow(10, d);
            return Math.round((nums[0] || 0) * factor) / factor;
          }
          case "floor":
            return Math.floor(nums[0] || 0);
          case "ceil":
            return Math.ceil(nums[0] || 0);
          case "abs":
            return Math.abs(nums[0] || 0);
          case "min":
            return nums.length ? Math.min(...nums) : 0;
          case "max":
            return nums.length ? Math.max(...nums) : 0;
          case "pow":
            return Math.pow(nums[0] || 0, nums[1] ?? 1);
          case "clamp":
            return Math.min(nums[2] ?? 100, Math.max(nums[1] ?? 0, nums[0] || 0));
          case "countTrue":
            return collectBooleans(model, strArg).filter(Boolean).length;
          case "countKeys":
            return collectBooleans(model, strArg).length;
          case "pctTrue": {
            const bools = collectBooleans(model, strArg);
            if (bools.length === 0) return 0;
            return Math.round((bools.filter(Boolean).length / bools.length) * 100);
          }
          default:
            return 0;
        }
      }

      if (name === "true") return 1;
      if (name === "false") return 0;
      const raw = getPointerValue(model, name);
      if (typeof raw === "boolean") return raw ? 1 : 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    consume();
    return 0;
  }

  try {
    const val = parseAddSub();
    return Number.isFinite(val) ? val : 0;
  } catch {
    return 0;
  }
}

function resolvePropValue(val: any, mergedModel: Record<string, any>): any {
  if (val && typeof val === "object" && typeof val.path === "string") {
    return getPointerValue(mergedModel, val.path);
  }
  if (typeof val === "string" && val.includes("{{/")) {
    return val.replace(/\{\{(\/[^}]+)\}\}/g, (_, ptr: string) => {
      const resolved = getPointerValue(mergedModel, ptr);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }
  return val;
}

export const A2UISurface: React.FC<A2UISurfaceProps> = ({
  surface,
  onAction,
  onPrefillInput,
  onLayoutChange,
}) => {
  const surfaceId = surface.createSurface?.surfaceId || surface.updateComponents?.surfaceId || "s_a2ui";
  const initialData = useMemo(
    () => (surface.updateDataModel?.data && typeof surface.updateDataModel.data === "object"
      ? { ...surface.updateDataModel.data }
      : {}),
    // Intentionally keyed by surfaceId so live user edits don't reset on parent re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surfaceId]
  );

  const [dataModel, setDataModel] = useState<Record<string, any>>(initialData);
  const [copiedBtnId, setCopiedBtnId] = useState<string | null>(null);

  useEffect(() => {
    setDataModel(initialData);
  }, [initialData]);

  // Compute live local reactive values (0ms, zero flash, zero eval)
  const { mergedModel, rawComputedNums } = useMemo(() => {
    const merged: Record<string, any> = { ...dataModel };
    const rawNums: Record<string, number> = {};
    const specs = surface.computed;
    if (specs && typeof specs === "object") {
      for (const [rawKey, spec] of Object.entries(specs)) {
        const key = rawKey.replace(/^\//, "");
        if (!key) continue;
        const expr = typeof spec === "string" ? spec : spec?.expr;
        if (!expr) continue;
        const numVal = evaluateSafeFormula(expr, merged);
        rawNums[key] = numVal;
        if (typeof spec === "object" && spec) {
          const hasFormat =
            typeof spec.prefix === "string" ||
            typeof spec.suffix === "string" ||
            typeof spec.decimals === "number";
          if (hasFormat) {
            const numText =
              typeof spec.decimals === "number"
                ? numVal.toFixed(Math.max(0, Math.min(6, spec.decimals)))
                : String(numVal);
            merged[key] = `${spec.prefix || ""}${numText}${spec.suffix || ""}`;
          } else {
            merged[key] = numVal;
          }
        } else {
          merged[key] = numVal;
        }
      }
    }
    return { mergedModel: merged, rawComputedNums: rawNums };
  }, [dataModel, surface.computed]);

  const componentMap = useMemo(() => {
    const map = new Map<string, A2UIComponentNode>();
    const list = Array.isArray(surface.updateComponents?.components)
      ? surface.updateComponents.components.slice(0, MAX_NODES)
      : [];
    for (const node of list) {
      if (node && typeof node.id === "string" && ALLOWED_CATALOG.has(node.component)) {
        map.set(node.id, node);
      }
    }
    return map;
  }, [surface.updateComponents?.components]);

  const rootId = useMemo(() => {
    const req = surface.updateComponents?.rootId || "root";
    if (componentMap.has(req)) return req;
    const first = componentMap.keys().next();
    return first.done ? "" : first.value;
  }, [componentMap, surface.updateComponents?.rootId]);

  const updateBoundValue = useCallback((pointer: string, nextValue: any) => {
    if (!pointer) return;
    setDataModel((prev) => setPointerImmutable(prev, pointer, nextValue));
  }, []);

  const handleButtonClick = useCallback(
    (node: A2UIComponentNode) => {
      const p = node.props || {};
      const label = String(resolvePropValue(p.label, mergedModel) ?? "Action");

      // 1. Optional direct clipboard copy action
      if (typeof p.copyText === "string" && p.copyText.trim()) {
        const textToCopy = String(resolvePropValue(p.copyText, mergedModel) ?? "");
        if (textToCopy && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(textToCopy).catch(() => {});
        }
        setCopiedBtnId(node.id);
        window.setTimeout(() => {
          setCopiedBtnId((cur) => (cur === node.id ? null : cur));
        }, 1400);
        if (!p.actionId) return;
      }

      // 2. Optional client prefill into Ask Aiden bar (e.g. "Revise plan: ")
      if (typeof p.clientPrefill === "string" && p.clientPrefill.length > 0) {
        const prefillStr = String(resolvePropValue(p.clientPrefill, mergedModel) ?? p.clientPrefill);
        if (onPrefillInput) {
          onPrefillInput(prefillStr);
        }
        return;
      }

      // 3. Lock & resolve local status badge cleanly to prevent double-submit
      const nextContext: Record<string, any> = { ...mergedModel };
      if (p.lockOnClick) {
        setDataModel((prev) => {
          const updated: Record<string, any> = { ...prev, locked: true };
          if (typeof p.resolvedLabel === "string" && p.resolvedLabel) {
            updated.statusLabel = p.resolvedLabel;
          }
          if (typeof p.resolvedTone === "string" && p.resolvedTone) {
            updated.statusTone = p.resolvedTone;
          }
          return updated;
        });
        nextContext.locked = true;
      }

      // 4. Dispatch scoped userAction back to AIDEN backend via WebSocket
      if (onAction && typeof p.actionId === "string" && p.actionId.trim()) {
        onAction({
          surfaceId,
          actionId: p.actionId.trim(),
          sourceComponentId: node.id,
          label,
          context: nextContext,
        });
      }
    },
    [mergedModel, onAction, onPrefillInput, surfaceId]
  );

  const renderNode = (nodeId: string, depth: number): React.ReactNode => {
    if (depth > MAX_DEPTH) return null;
    const node = componentMap.get(nodeId);
    if (!node || !ALLOWED_CATALOG.has(node.component)) return null;

    const p = node.props || {};
    const isDisabled = p.disableWhen ? Boolean(getPointerValue(mergedModel, String(p.disableWhen))) : false;

    switch (node.component) {
      case "Card":
        return (
          <div key={node.id} className="a2ui-card">
            {(node.children || []).map((cid) => renderNode(cid, depth + 1))}
          </div>
        );

      case "Column":
        return (
          <div
            key={node.id}
            className="a2ui-column"
            style={{ gap: `${typeof p.gap === "number" ? p.gap : 8}px` }}
          >
            {(node.children || []).map((cid) => renderNode(cid, depth + 1))}
          </div>
        );

      case "Row":
        return (
          <div
            key={node.id}
            className={`a2ui-row ${p.spread ? "spread" : ""} ${p.stretch ? "stretch" : ""}`}
            style={{ gap: `${typeof p.gap === "number" ? p.gap : 8}px` }}
          >
            {(node.children || []).map((cid) => renderNode(cid, depth + 1))}
          </div>
        );

      case "Text": {
        const variant = typeof p.variant === "string" ? p.variant : "body";
        const content = String(resolvePropValue(p.text, mergedModel) ?? "");
        return (
          <p key={node.id} className={`a2ui-text ${variant}`}>
            {content}
          </p>
        );
      }

      case "Badge": {
        const tone = String(resolvePropValue(p.tone, mergedModel) ?? "");
        const content = String(resolvePropValue(p.text, mergedModel) ?? "");
        return (
          <span key={node.id} className={`a2ui-badge ${tone}`}>
            {content}
          </span>
        );
      }

      case "Divider":
        return <div key={node.id} className="a2ui-divider" />;

      case "ListItem": {
        const left = String(resolvePropValue(p.left, mergedModel) ?? "");
        const right = p.right !== undefined ? String(resolvePropValue(p.right, mergedModel) ?? "") : "";
        const tone = String(resolvePropValue(p.tone, mergedModel) ?? "");
        return (
          <div key={node.id} className="a2ui-list-item">
            <span className="a2ui-list-item-left">{left}</span>
            {right && <span className={`a2ui-badge ${tone}`}>{right}</span>}
          </div>
        );
      }

      case "Button": {
        const variant = typeof p.variant === "string" ? p.variant : "";
        const rawLabel = String(resolvePropValue(p.label, mergedModel) ?? "Action");
        const displayLabel = copiedBtnId === node.id ? "✓ Copied" : rawLabel;
        return (
          <button
            key={node.id}
            type="button"
            className={`a2ui-btn ${variant}`}
            disabled={isDisabled}
            onClick={(e) => {
              e.stopPropagation();
              handleButtonClick(node);
            }}
          >
            {displayLabel}
          </button>
        );
      }

      case "TextField": {
        const bindPath = typeof p.bind === "string" ? p.bind : "";
        const value = bindPath ? String(getPointerValue(dataModel, bindPath) ?? "") : "";
        const placeholder = typeof p.placeholder === "string" ? p.placeholder : "";
        return (
          <div key={node.id} className="a2ui-field-wrap">
            {p.label && <label className="a2ui-field-label">{String(p.label)}</label>}
            {p.multiline ? (
              <textarea
                className="a2ui-textarea"
                value={value}
                placeholder={placeholder}
                disabled={isDisabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => updateBoundValue(bindPath, e.target.value)}
              />
            ) : (
              <input
                type="text"
                className="a2ui-input"
                value={value}
                placeholder={placeholder}
                disabled={isDisabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => updateBoundValue(bindPath, e.target.value)}
              />
            )}
          </div>
        );
      }

      case "CheckBox": {
        const bindPath = typeof p.bind === "string" ? p.bind : "";
        const checked = bindPath ? Boolean(getPointerValue(dataModel, bindPath)) : false;
        const strikeOnCheck = Boolean(p.strikeOnCheck);
        return (
          <button
            key={node.id}
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={isDisabled}
            className={`a2ui-checkbox-row ${checked ? "checked" : ""} ${
              strikeOnCheck ? "strike-on-check" : ""
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (!isDisabled && bindPath) {
                updateBoundValue(bindPath, !checked);
              }
            }}
          >
            <span className="a2ui-checkbox-box" aria-hidden="true">
              {checked ? "✓" : ""}
            </span>
            <span className="a2ui-checkbox-label">{String(p.label ?? "")}</span>
          </button>
        );
      }

      case "ChoiceChips": {
        const bindPath = typeof p.bind === "string" ? p.bind : "";
        const selected = bindPath ? String(getPointerValue(dataModel, bindPath) ?? "") : "";
        const options = Array.isArray(p.options) ? p.options.map((o: any) => String(o)) : [];
        return (
          <div key={node.id} className="a2ui-field-wrap">
            {p.label && <span className="a2ui-field-label">{String(p.label)}</span>}
            <div className="a2ui-chips">
              {options.map((opt: string) => (
                <button
                  key={opt}
                  type="button"
                  disabled={isDisabled}
                  className={`a2ui-chip ${selected === opt ? "selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isDisabled) return;
                    if (bindPath) {
                      updateBoundValue(bindPath, opt);
                    }
                    if (onAction && typeof p.actionId === "string" && p.actionId.trim()) {
                      const nextCtx = bindPath
                        ? setPointerImmutable(mergedModel, bindPath, opt)
                        : { ...mergedModel };
                      onAction({
                        surfaceId,
                        actionId: p.actionId.trim(),
                        sourceComponentId: node.id,
                        label: opt,
                        context: nextCtx,
                      });
                    }
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        );
      }

      case "Slider": {
        const bindPath = typeof p.bind === "string" ? p.bind : "";
        const min = typeof p.min === "number" ? p.min : 0;
        const max = typeof p.max === "number" ? p.max : 100;
        const step = typeof p.step === "number" && p.step > 0 ? p.step : 1;
        const rawVal = bindPath ? Number(getPointerValue(dataModel, bindPath)) : min;
        const val = Number.isFinite(rawVal) ? rawVal : min;
        const unit = typeof p.unit === "string" ? p.unit : "";
        const displayVal = p.prefix ? `${unit}${val}` : `${val}${unit}`;
        return (
          <div key={node.id} className="a2ui-slider-wrap" onClick={(e) => e.stopPropagation()}>
            <div className="a2ui-slider-head">
              <span className="a2ui-slider-label">{String(p.label ?? "")}</span>
              <strong className="a2ui-slider-val">{displayVal}</strong>
            </div>
            <input
              type="range"
              className="a2ui-slider"
              min={min}
              max={max}
              step={step}
              value={val}
              disabled={isDisabled}
              onChange={(e) => {
                if (bindPath) {
                  updateBoundValue(bindPath, Number(e.target.value));
                }
              }}
            />
          </div>
        );
      }

      case "Metric": {
        const label = String(resolvePropValue(p.label, mergedModel) ?? "");
        const value = String(resolvePropValue(p.value, mergedModel) ?? "");
        const sub = p.sub !== undefined ? String(resolvePropValue(p.sub, mergedModel) ?? "") : "";
        return (
          <div key={node.id} className="a2ui-metric">
            <span className="a2ui-metric-label">{label}</span>
            <span className="a2ui-metric-val">{value}</span>
            {sub && <span className="a2ui-metric-sub">{sub}</span>}
          </div>
        );
      }

      case "Progress": {
        const rawResolved = resolvePropValue(p.value, mergedModel);
        let pctNum = Number(rawResolved);
        if (!Number.isFinite(pctNum) && p.value && typeof p.value === "object" && typeof p.value.path === "string") {
          const cleanKey = p.value.path.replace(/^\//, "");
          if (cleanKey in rawComputedNums) {
            pctNum = rawComputedNums[cleanKey];
          }
        }
        if (!Number.isFinite(pctNum) && typeof rawResolved === "string") {
          pctNum = parseFloat(rawResolved.replace(/[^0-9.-]/g, ""));
        }
        const pct = Math.max(0, Math.min(100, Number.isFinite(pctNum) ? Math.round(pctNum) : 0));
        const tone = String(resolvePropValue(p.tone, mergedModel) ?? "");
        const label = String(resolvePropValue(p.label, mergedModel) ?? "");
        return (
          <div key={node.id} className="a2ui-progress-wrap">
            <div className="a2ui-progress-head">
              <span>{label}</span>
              <strong>{pct}%</strong>
            </div>
            <div className="a2ui-progress-track">
              <div className={`a2ui-progress-fill ${tone}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      }

      case "Tabs": {
        const tabs = Array.isArray(p.tabs) ? p.tabs : [];
        const bindPath = typeof p.bind === "string" ? p.bind : "";
        const activeId =
          (bindPath ? String(getPointerValue(dataModel, bindPath) ?? "") : "") ||
          (tabs[0]?.id ? String(tabs[0].id) : "");
        const activeTab = tabs.find((t: any) => String(t?.id) === activeId) || tabs[0];
        return (
          <div key={node.id} className="a2ui-column" style={{ gap: "10px" }}>
            <div className="a2ui-tabs-header">
              {tabs.map((tab: any) => {
                const tid = String(tab?.id ?? "");
                return (
                  <button
                    key={tid}
                    type="button"
                    className={`a2ui-tab-btn ${activeId === tid ? "active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (bindPath) {
                        updateBoundValue(bindPath, tid);
                      }
                      if (onLayoutChange) {
                        window.requestAnimationFrame(() => onLayoutChange());
                      }
                    }}
                  >
                    {String(tab?.label ?? tid)}
                  </button>
                );
              })}
            </div>
            {activeTab?.childId && renderNode(String(activeTab.childId), depth + 1)}
          </div>
        );
      }

      default:
        return null;
    }
  };

  if (!rootId) return null;

  return <div className="a2ui-surface-root">{renderNode(rootId, 0)}</div>;
};
