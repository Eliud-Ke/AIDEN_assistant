"""
AIDEN x Google A2UI v0.9 Engine (Backend Tool, Validator & Deterministic Builders).

Produces declarative, catalog-allowlisted A2UI v0.9 JSON surfaces wrapped in
`::a2ui-card[...]::` tags for the React Liquid-Glass renderer (`A2UISurface.tsx`).
Zero raw HTML/JS is ever emitted; all components are validated against `aiden.glass.v1`.
"""

import json
import re
import threading
import time
from typing import Any, Dict, List, Optional

A2UI_VERSION = "v0.9"
A2UI_CATALOG_ID = "aiden.glass.v1"
MAX_NODES = 40
MAX_DEPTH = 7
MAX_ROW_CHILDREN = 4

_PENDING_LOCK = threading.Lock()
_PENDING_SURFACES: List[Dict[str, Any]] = []


def clear_pending_surfaces() -> None:
    """Clears any queued per-turn A2UI surfaces at the start of a new turn."""
    with _PENDING_LOCK:
        _PENDING_SURFACES.clear()


def enqueue_pending_surface(envelope: Dict[str, Any]) -> None:
    """Queues a validated A2UI surface to be auto-mounted on stream_end for this turn."""
    if not isinstance(envelope, dict):
        return
    with _PENDING_LOCK:
        # Cap to 2 surfaces per turn to keep the 466px pill crisp
        if len(_PENDING_SURFACES) >= 2:
            _PENDING_SURFACES.pop(0)
        _PENDING_SURFACES.append(envelope)


def pop_pending_surfaces() -> List[Dict[str, Any]]:
    """Pops and returns all validated A2UI surfaces queued during the current turn."""
    with _PENDING_LOCK:
        items = list(_PENDING_SURFACES)
        _PENDING_SURFACES.clear()
        return items

ALLOWED_CATALOG = frozenset(
    {
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
    }
)

_SURFACE_SEQ = 0


def _next_surface_id(prefix: str = "s_a2ui") -> str:
    global _SURFACE_SEQ
    _SURFACE_SEQ += 1
    clean_prefix = re.sub(r"[^a-zA-Z0-9_-]", "", prefix or "s_a2ui")[:24] or "s_a2ui"
    return f"{clean_prefix}_{int(time.time() * 1000) % 100000}_{_SURFACE_SEQ}"


def _sanitize_props(props: Any) -> Dict[str, Any]:
    """Keeps JSON-safe primitive/list/dict props and strips overly large values."""
    if not isinstance(props, dict):
        return {}
    out: Dict[str, Any] = {}
    for k, v in props.items():
        key = str(k)[:48]
        if key.lower() in ("dangerouslysetinnerhtml", "innerhtml", "onclick", "onerror", "script"):
            continue
        if isinstance(v, (bool, int, float)) or v is None:
            out[key] = v
        elif isinstance(v, str):
            out[key] = v[:1200]
        elif isinstance(v, list):
            clean_list = []
            for item in v[:20]:
                if isinstance(item, (str, int, float, bool)):
                    clean_list.append(item if not isinstance(item, str) else item[:240])
                elif isinstance(item, dict):
                    clean_list.append(_sanitize_props(item))
            out[key] = clean_list
        elif isinstance(v, dict):
            out[key] = _sanitize_props(v)
    return out


def _sanitize_data_model(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Any] = {}
    for idx, (k, v) in enumerate(data.items()):
        if idx >= 60:
            break
        key = str(k)[:64]
        if isinstance(v, (bool, int, float)) or v is None:
            out[key] = v
        elif isinstance(v, str):
            out[key] = v[:1500]
        elif isinstance(v, list):
            out[key] = [
                x[:240] if isinstance(x, str) else x
                for x in v[:24]
                if isinstance(x, (str, int, float, bool))
            ]
        elif isinstance(v, dict):
            out[key] = _sanitize_data_model(v)
    return out


def _sanitize_computed(computed: Any) -> Dict[str, Dict[str, Any]]:
    """Sanitizes optional safe declarative formula bindings for reactive calculators/checklists."""
    if not isinstance(computed, dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for idx, (k, spec) in enumerate(computed.items()):
        if idx >= 24:
            break
        key = str(k).lstrip("/")[:64]
        if not key:
            continue
        if isinstance(spec, str):
            out[key] = {"expr": spec[:200]}
        elif isinstance(spec, dict) and isinstance(spec.get("expr"), str):
            entry: Dict[str, Any] = {"expr": spec["expr"][:200]}
            if isinstance(spec.get("prefix"), str):
                entry["prefix"] = spec["prefix"][:16]
            if isinstance(spec.get("suffix"), str):
                entry["suffix"] = spec["suffix"][:24]
            if isinstance(spec.get("decimals"), int) and 0 <= spec["decimals"] <= 6:
                entry["decimals"] = spec["decimals"]
            out[key] = entry
    return out


def normalize_a2ui_payload(
    components: List[Dict[str, Any]],
    data_model: Optional[Dict[str, Any]] = None,
    computed: Optional[Dict[str, Any]] = None,
    surface_id: str = "",
    root_id: str = "root",
) -> Dict[str, Any]:
    """
    Validates & normalizes a raw component list into an A2UI v0.9 wire envelope
    governed by `aiden.glass.v1` catalog guardrails.
    """
    sid = surface_id.strip() if isinstance(surface_id, str) and surface_id.strip() else _next_surface_id()
    raw_list = components if isinstance(components, list) else []

    clean_components: List[Dict[str, Any]] = []
    seen_ids = set()
    dropped: List[str] = []

    for item in raw_list:
        if len(clean_components) >= MAX_NODES:
            break
        if not isinstance(item, dict):
            continue
        cid = str(item.get("id") or "").strip()[:64]
        comp_name = str(item.get("component") or "").strip()
        if not cid or cid in seen_ids:
            continue
        if comp_name not in ALLOWED_CATALOG:
            dropped.append(f"{comp_name}#{cid}")
            continue

        node: Dict[str, Any] = {
            "id": cid,
            "component": comp_name,
        }
        props = _sanitize_props(item.get("props"))
        if props:
            node["props"] = props

        children = item.get("children")
        if isinstance(children, list):
            clean_children = [str(c).strip()[:64] for c in children if isinstance(c, str) and c.strip()]
            if comp_name == "Row" and len(clean_children) > MAX_ROW_CHILDREN:
                # Keep all children valid (Row wraps cleanly in CSS), capped at 8 for pill safety
                clean_children = clean_children[:8]
            if clean_children:
                node["children"] = clean_children

        seen_ids.add(cid)
        clean_components.append(node)

    # Resolve rootId cleanly if caller omitted "root"
    resolved_root = str(root_id or "root").strip()
    if resolved_root not in seen_ids and clean_components:
        resolved_root = clean_components[0]["id"]

    # Prune references to dropped/non-existent children
    for node in clean_components:
        if "children" in node:
            node["children"] = [c for c in node["children"] if c in seen_ids]

    envelope: Dict[str, Any] = {
        "version": A2UI_VERSION,
        "createSurface": {
            "surfaceId": sid,
            "catalogId": A2UI_CATALOG_ID,
        },
        "updateDataModel": {
            "surfaceId": sid,
            "data": _sanitize_data_model(data_model),
        },
        "updateComponents": {
            "surfaceId": sid,
            "rootId": resolved_root,
            "components": clean_components,
        },
    }

    clean_computed = _sanitize_computed(computed)
    if clean_computed:
        envelope["computed"] = clean_computed

    if dropped:
        print(f"🛡️ [A2UI GUARDRAIL] Dropped disallowed component(s): {', '.join(dropped)}")

    return envelope


def serialize_a2ui_card_tag(envelope: Dict[str, Any]) -> str:
    """Serializes an A2UI envelope into a collision-safe `::a2ui-card[...]::` embed tag."""
    raw_json = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
    # Prevent accidental early match if any string value literally contains `]::`
    safe_json = raw_json.replace("]::", r"\u005d::")
    return f"::a2ui-card[{safe_json}]::"


def render_a2ui_surface(
    components: List[Dict[str, Any]],
    data_model: Optional[Dict[str, Any]] = None,
    computed: Optional[Dict[str, Any]] = None,
    surface_id: str = "",
    root_id: str = "root",
) -> str:
    """
    Core Tool: Validates and packages a declarative A2UI v0.9 surface into a
    `::a2ui-card[...]::` tag ready for AIDEN to embed right below a crisp 1-sentence intro.
    """
    envelope = normalize_a2ui_payload(
        components=components,
        data_model=data_model,
        computed=computed,
        surface_id=surface_id,
        root_id=root_id,
    )
    comps = envelope["updateComponents"]["components"]
    if not comps:
        return (
            "Error: No valid components from catalog `aiden.glass.v1` were provided. "
            f"Allowed components: {', '.join(sorted(ALLOWED_CATALOG))}."
        )

    enqueue_pending_surface(envelope)
    sid = envelope["createSurface"]["surfaceId"]
    return (
        f"[A2UI SURFACE QUEUED AUTOMATICALLY - {sid} ({len(comps)} nodes)]\n"
        "The interactive glass card is already validated and queued to render automatically directly below your message.\n"
        "Do NOT write any JSON, code blocks, or `::a2ui-card` tags in your reply — just reply with ONE short, "
        "natural conversational sentence introducing the card!"
    )


def build_antigravity_plan_a2ui_tag(job: Dict[str, Any]) -> str:
    """
    Deterministic Python builder for the Antigravity Work Plan Gate A2UI card.
    Keeps `AntigravityWorkCard.tsx` untouched for execution while giving the user
    one-click Approve & Run / Revise / Cancel buttons before Turbo execution starts.
    """
    job_id = str(job.get("job_id") or "agy-1")
    plan = job.get("plan") or {}
    summary = str(plan.get("summary") or "Execution plan prepared.").strip()
    steps = [str(s).strip() for s in (plan.get("steps") or []) if str(s).strip()][:5]
    paths = [str(p).strip() for p in (plan.get("paths_affected") or []) if str(p).strip()][:4]
    risks = str(plan.get("serious_harm_or_risks") or "").strip()
    risk_level = str(plan.get("risk_level") or "low").strip().lower()

    risk_tone = "rose" if risk_level == "high" else ("amber" if risk_level == "medium" else "emerald")
    risk_badge = f"{risk_level.upper()} RISK"

    root_children: List[str] = ["hdr", "summary"]
    components: List[Dict[str, Any]] = [
        {"id": "root", "component": "Card", "children": root_children},
        {"id": "hdr", "component": "Row", "props": {"spread": True, "gap": 8}, "children": ["title", "status_badge"]},
        {
            "id": "title",
            "component": "Text",
            "props": {
                "text": f"Antigravity Plan · {max(1, len(steps))} Step{'s' if len(steps) != 1 else ''}",
                "variant": "title",
            },
        },
        {
            "id": "status_badge",
            "component": "Badge",
            "props": {"text": {"path": "/statusLabel"}, "tone": {"path": "/statusTone"}},
        },
        {"id": "summary", "component": "Text", "props": {"text": summary[:320], "variant": "subtitle"}},
    ]

    if steps:
        root_children.append("div_steps")
        components.append({"id": "div_steps", "component": "Divider"})
        step_ids: List[str] = []
        for idx, step in enumerate(steps):
            sid = f"step_{idx}"
            step_ids.append(sid)
            components.append(
                {
                    "id": sid,
                    "component": "Text",
                    "props": {"text": f"{idx + 1}. {step[:180]}", "variant": "body"},
                }
            )
        root_children.append("steps_col")
        components.append({"id": "steps_col", "component": "Column", "props": {"gap": 4}, "children": step_ids})

    if paths:
        root_children.append("div_paths")
        components.append({"id": "div_paths", "component": "Divider"})
        path_ids: List[str] = []
        for idx, p in enumerate(paths):
            pid = f"path_{idx}"
            path_ids.append(pid)
            short_p = p.replace("\\", "/")
            if len(short_p) > 46:
                short_p = "..." + short_p[-43:]
            components.append(
                {
                    "id": pid,
                    "component": "ListItem",
                    "props": {"left": short_p, "right": "Scope", "tone": "sky"},
                }
            )
        root_children.append("paths_col")
        components.append({"id": "paths_col", "component": "Column", "props": {"gap": 5}, "children": path_ids})

    if risks and risks.lower() not in ("none", "none stated", "no serious risks"):
        root_children.append("risk_row")
        components.append(
            {
                "id": "risk_row",
                "component": "Row",
                "props": {"gap": 7},
                "children": ["risk_chip", "risk_note"],
            }
        )
        components.append({"id": "risk_chip", "component": "Badge", "props": {"text": risk_badge, "tone": risk_tone}})
        components.append({"id": "risk_note", "component": "Text", "props": {"text": risks[:200], "variant": "caption"}})

    root_children.extend(["div_actions", "actions"])
    components.extend(
        [
            {"id": "div_actions", "component": "Divider"},
            {
                "id": "actions",
                "component": "Row",
                "props": {"gap": 8, "stretch": True},
                "children": ["btn_approve", "btn_revise", "btn_cancel"],
            },
            {
                "id": "btn_approve",
                "component": "Button",
                "props": {
                    "label": "Approve & Run",
                    "variant": "emerald",
                    "actionId": "agy_approve_plan",
                    "disableWhen": "/locked",
                    "lockOnClick": True,
                    "resolvedLabel": "✓ Approved · Launching",
                    "resolvedTone": "emerald",
                },
            },
            {
                "id": "btn_revise",
                "component": "Button",
                "props": {
                    "label": "Revise",
                    "variant": "ghost",
                    "actionId": "agy_revise_plan",
                    "disableWhen": "/locked",
                    "clientPrefill": "Revise the Antigravity plan: ",
                },
            },
            {
                "id": "btn_cancel",
                "component": "Button",
                "props": {
                    "label": "Cancel",
                    "variant": "danger",
                    "actionId": "agy_cancel_plan",
                    "disableWhen": "/locked",
                    "lockOnClick": True,
                    "resolvedLabel": "Cancelled",
                    "resolvedTone": "rose",
                },
            },
        ]
    )

    envelope = normalize_a2ui_payload(
        components=components,
        data_model={
            "job_id": job_id,
            "task": str(job.get("task") or "")[:200],
            "statusLabel": "Awaiting Approval",
            "statusTone": risk_tone if risk_level == "high" else "amber",
            "locked": False,
        },
        surface_id=f"s_agy_plan_{job_id}",
        root_id="root",
    )
    enqueue_pending_surface(envelope)
    return serialize_a2ui_card_tag(envelope)


A2UI_TOOLS = {
    "render_a2ui_surface": render_a2ui_surface,
}
