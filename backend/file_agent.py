r"""
AIDEN TIER 2 FILE EXPLORER AGENT — CONTROLLED HIVE-MIND SWARM
Async Recursive Fork-Join directory explorer with 2-layer memory:
  - Short-term Hive-Mind State: Semaphore(3) concurrency valve, global LLM budget (12),
    shared visited_paths, zero-token local scouts (corridor fast-forward + instant empty
    dead-ends), Wave-2 standby backtracking (0 extra LLM calls), instant found_event kill-switch,
    and a shared near_misses basket.
  - Long-term Spatial Memory: Lightweight folder-role landmarks persisted in
    %LOCALAPPDATA%\AidenAssistant\file_landmarks.json (folder categories ONLY — never
    filenames, never file contents, never secrets).
  - STRICT ZERO-READ PRIVACY: Only reads os.scandir metadata (name, is_dir, mtime).
    Never opens or reads any file contents.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from openai import AsyncOpenAI

try:
    from auth_manager import get_api_key
except ImportError:
    from backend.auth_manager import get_api_key  # type: ignore

try:
    from configuration import USER_DATA_DIR
except ImportError:
    from backend.configuration import USER_DATA_DIR  # type: ignore

SWARM_MODEL = "gpt-5.6-luna"
MAX_CONCURRENT_AGENTS = 3
MAX_LLM_CALLS = 12
MAX_DEPTH = 5
MAX_CORRIDOR_HOPS = 3
MAX_ENTRIES_IN_PROMPT = 80
LANDMARKS_FILE = USER_DATA_DIR / "file_landmarks.json"

# OS / system noise skipped at drive root
IGNORED_ROOT_DIRS = {
    "windows",
    "documents and settings",
    "intel",
    "perflogs",
    "recovery",
    "programdata",
    "msocache",
    "config.msi",
    "boot",
}

# Noise skipped anywhere in the tree (unless user explicitly names one in goal)
ALWAYS_IGNORED_DIRS = {
    "$recycle.bin",
    "system volume information",
    "node_modules",
    "__pycache__",
    "site-packages",
    ".git",
    ".venv",
    "venv",
    ".vscode",
    ".idea",
    ".cache",
    "windowsapps",
    "appdata",
}

# Built-in Windows profile noise inside C:\Users
USERS_NOISE_DIRS = {
    "public",
    "default",
    "default user",
    "all users",
    "defaultapppool",
}

DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {
            "type": "string",
            "enum": ["found", "explore", "dead_end"],
            "description": "'found' if an exact/clear match is in the current listing, 'explore' to drill into promising subfolders, or 'dead_end' if nothing here is relevant.",
        },
        "matched_name": {
            "type": "string",
            "description": "Exact filename or folder name from the current listing when decision is 'found', otherwise empty string.",
        },
        "matched_is_dir": {
            "type": "boolean",
            "description": "True if matched_name is a folder, False if it is a file.",
        },
        "ranked_subfolders": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Up to 4 exact subfolder names from the current listing ranked from MOST promising to least promising (used for Wave 1 + Wave 2 backtracking). Empty array unless decision is 'explore'.",
        },
        "near_miss_names": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Up to 2 exact filenames/folder names from the current listing that look close to the target even if not an exact match (empty array if none).",
        },
    },
    "required": [
        "decision",
        "matched_name",
        "matched_is_dir",
        "ranked_subfolders",
        "near_miss_names",
    ],
    "additionalProperties": False,
}

NODE_SYSTEM_PROMPT = (
    "You are a fast, privacy-first Windows file-locator micro-agent inside a parallel swarm. "
    "You ONLY see folder/file names (never file contents). Given the user's target goal, optional "
    "file extension filter, current folder breadcrumb, and directory entries:\n"
    "1. If the exact target file or folder is clearly present in this listing, return decision='found' "
    "with the EXACT entry name in matched_name and set matched_is_dir accurately.\n"
    "2. Otherwise, if promising subfolders exist that could contain the target, return decision='explore' "
    "and list up to 4 EXACT subfolder names from this listing in ranked_subfolders (best first). "
    "Do NOT invent folder names or repeat already-dead siblings.\n"
    "3. If no subfolder looks plausible for this goal, return decision='dead_end'.\n"
    "4. Whenever you spot a close near-match (similar topic/date/type, not exact), include its exact name "
    "in near_miss_names so the user gets a helpful fallback if the exact target doesn't exist.\n"
    "Never guess or invent names not present in the provided listing."
)

# Active job registry (mirrors tools_antigravity.py thread-safe job management)
_HUNT_LOCK = threading.Lock()
_HUNTS: Dict[str, Dict[str, Any]] = {}
_HUNT_COUNTER = 0


def _broadcast(payload: Dict[str, Any]) -> None:
    """Thread-safe broadcast to WebSocket UI clients."""
    try:
        try:
            import server
        except ImportError:
            from backend import server  # type: ignore
        server.broadcast_event(payload)
    except Exception:
        pass


def _enqueue_hunt_completion(
    job_id: str,
    goal: str,
    status: str,
    found_path: str,
    pending_action: str,
    checked_summary: List[str],
    near_misses: List[Dict[str, str]],
    elapsed_sec: float,
) -> None:
    """Queues a Turn-Barrier Mailbox event so AIDEN wakes up and completes any chained action."""
    try:
        try:
            import server
        except ImportError:
            from backend import server  # type: ignore

        if status == "found" and found_path:
            action_clause = (
                f"The user's original pending follow-up action was: '{pending_action}'. "
                f"Execute that follow-up action right now using the matching `file_*` tool "
                f"(for example `file_move`, `file_copy`, `file_open`, or `file_trash`) on '{found_path}', "
                f"then tell the user warmly where you found it and confirm the action is complete!"
                if pending_action
                else "Tell the user warmly and concisely where you found it (the interactive card with Open and Open in Folder buttons is already visible below your message, so keep it punchy — do NOT call any tools unless needed)."
            )
            prompt = (
                f"[FILE AGENT FOUND - {job_id}]: "
                f"Your background File Explorer swarm located the target for '{goal}' in {elapsed_sec:.1f}s "
                f"(strictly metadata-only, 0 files read).\n"
                f"VERIFIED PATH: {found_path}\n"
                f"{action_clause}"
            )
            ui_tag = "File located"
        elif status == "stopped":
            return  # User manually stopped; no intrusive proactive turn needed
        else:
            checked_str = ", ".join(checked_summary[:6]) if checked_summary else "primary folders on C:\\"
            nm_lines = ""
            if near_misses:
                top_nm = near_misses[:3]
                nm_formatted = "; ".join(f"{nm['name']} ({nm['path']})" for nm in top_nm)
                nm_lines = f"\nClosest near-matches spotted along the way: {nm_formatted}."
            prompt = (
                f"[FILE AGENT DEAD END - {job_id}]: "
                f"Your background File Explorer swarm finished searching for '{goal}' ({elapsed_sec:.1f}s) "
                f"without finding an exact match. Checked branches: {checked_str}.{nm_lines}\n"
                f"Let the user know naturally in 1-2 short sentences, mention the closest near-match if any "
                f"was spotted, and ask if they'd like to check another drive or folder. Do NOT call any tools."
            )
            ui_tag = "File search finished"

        server.enqueue_system_turn(
            kind="file_agent_done",
            prompt=prompt,
            job_id=job_id,
            require_maximized=True,
            ui_tag=ui_tag,
        )
    except Exception as exc:
        print(f"⚠️ [FILE AGENT] Failed to enqueue completion turn: {exc}")


# -------------------------------------------------------------------------
# LONG-TERM SPATIAL LANDMARKS MEMORY (Folder Roles ONLY — Zero Filenames!)
# -------------------------------------------------------------------------
def _load_landmarks() -> List[Dict[str, Any]]:
    if not LANDMARKS_FILE.exists():
        return []
    try:
        with open(LANDMARKS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict) and d.get("path")]
    except Exception:
        pass
    return []


def _record_landmark(folder_path: str, goal: str) -> None:
    """Persists ONLY the parent folder path + high-level goal keywords (never filenames/contents)."""
    try:
        norm = str(Path(folder_path).resolve())
        if not os.path.isdir(norm):
            return
        tokens = [
            t.lower()
            for t in re.findall(r"[a-zA-Z0-9]{3,}", goal or "")
            if t.lower() not in {"the", "and", "for", "find", "file", "folder", "move", "copy", "open", "desktop", "pdf", "doc", "docx", "txt", "png", "jpg", "mp4"}
        ][:5]
        if not tokens:
            return
        landmarks = _load_landmarks()
        key = os.path.normcase(norm)
        updated = False
        for item in landmarks:
            if os.path.normcase(str(item.get("path", ""))) == key:
                existing_tags = set(str(t).lower() for t in item.get("tags", []))
                existing_tags.update(tokens)
                item["tags"] = sorted(existing_tags)[:12]
                item["hits"] = int(item.get("hits", 1)) + 1
                item["last_seen"] = int(time.time())
                updated = True
                break
        if not updated:
            landmarks.append({
                "path": norm,
                "tags": sorted(set(tokens))[:12],
                "hits": 1,
                "last_seen": int(time.time()),
            })
        landmarks.sort(key=lambda x: (int(x.get("hits", 0)), int(x.get("last_seen", 0))), reverse=True)
        landmarks = landmarks[:24]
        LANDMARKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LANDMARKS_FILE, "w", encoding="utf-8") as f:
            json.dump(landmarks, f, indent=2)
    except Exception:
        pass


def _matching_landmarks_hint(goal: str, start_root: str) -> str:
    """Returns a compact 1-2 line spatial landmark hint for folders under start_root."""
    landmarks = _load_landmarks()
    if not landmarks:
        return ""
    goal_tokens = set(t.lower() for t in re.findall(r"[a-zA-Z0-9]{3,}", goal or ""))
    root_norm = os.path.normcase(os.path.abspath(start_root))
    hits = []
    for lm in landmarks:
        p = str(lm.get("path", ""))
        if not p or not os.path.isdir(p):
            continue
        if not os.path.normcase(p).startswith(root_norm):
            continue
        tags = set(str(t).lower() for t in lm.get("tags", []))
        overlap = goal_tokens.intersection(tags)
        if overlap:
            hits.append((len(overlap), int(lm.get("hits", 1)), p, sorted(tags)[:4]))
    if not hits:
        return ""
    hits.sort(reverse=True)
    lines = [f"- {p} (past topics: {', '.join(tags)})" for _, _, p, tags in hits[:3]]
    return "KNOWN FOLDER LANDMARKS FROM PAST HUNTS (hints only, verify before concluding):\n" + "\n".join(lines)


# -------------------------------------------------------------------------
# ZERO-READ LOCAL FILESYSTEM SCANNER (os.scandir metadata only)
# -------------------------------------------------------------------------
def _goal_keywords(goal: str) -> List[str]:
    return [t.lower() for t in re.findall(r"[a-zA-Z0-9]{2,}", goal or "")]


def _should_skip_dir(name_lower: str, is_root: bool, allow_appdata: bool) -> bool:
    if name_lower.startswith("."):
        return True
    if name_lower == "appdata" and allow_appdata:
        return False
    if name_lower in ALWAYS_IGNORED_DIRS:
        return True
    if is_root and name_lower in IGNORED_ROOT_DIRS:
        return True
    return False


def _scan_dir_metadata(
    path: str,
    root_path: str,
    norm_exts: Set[str],
    goal_words: List[str],
    allow_appdata: bool,
) -> Tuple[List[str], List[Tuple[str, str]], int]:
    """
    Scans a single directory using os.scandir (metadata ONLY — zero file reads).
    Returns: (subfolders_sorted, files_as_(name, ext_tag), omitted_count)
    """
    is_root = os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(root_path))
    is_users_dir = os.path.basename(os.path.normpath(path)).lower() == "users"

    dirs: List[Tuple[int, float, str]] = []
    files: List[Tuple[int, float, str, str]] = []

    try:
        with os.scandir(path) as it:
            for entry in it:
                name = entry.name
                nl = name.lower()
                if getattr(entry, "is_junction", lambda: False)():
                    continue
                try:
                    is_d = entry.is_dir(follow_symlinks=False)
                except OSError:
                    continue

                if is_d:
                    if _should_skip_dir(nl, is_root, allow_appdata):
                        continue
                    if is_users_dir and nl in USERS_NOISE_DIRS:
                        continue
                    score = sum(1 for w in goal_words if w in nl)
                    try:
                        mtime = entry.stat(follow_symlinks=False).st_mtime
                    except OSError:
                        mtime = 0.0
                    dirs.append((score, mtime, name))
                else:
                    if name.startswith("."):
                        continue
                    _, ext = os.path.splitext(name)
                    ext_lower = ext.lower()
                    if norm_exts and ext_lower not in norm_exts:
                        continue
                    score = sum(1 for w in goal_words if w in nl)
                    try:
                        mtime = entry.stat(follow_symlinks=False).st_mtime
                    except OSError:
                        mtime = 0.0
                    tag = ext.lstrip(".").upper() if ext else "FILE"
                    files.append((score, mtime, name, tag))
    except (PermissionError, FileNotFoundError, OSError):
        return [], [], 0

    # Prioritize keyword matches, then most recently modified
    dirs.sort(key=lambda x: (-x[0], -x[1], x[2].lower()))
    files.sort(key=lambda x: (-x[0], -x[1], x[2].lower()))

    total = len(dirs) + len(files)
    max_dirs = min(len(dirs), 40)
    max_files = min(len(files), MAX_ENTRIES_IN_PROMPT - max_dirs)
    if len(files) < MAX_ENTRIES_IN_PROMPT - max_dirs:
        max_dirs = min(len(dirs), MAX_ENTRIES_IN_PROMPT - len(files))

    kept_dirs = [d[2] for d in dirs[:max_dirs]]
    kept_files = [(f[2], f[3]) for f in files[:max_files]]
    omitted = max(0, total - len(kept_dirs) - len(kept_files))
    return kept_dirs, kept_files, omitted


def _fast_forward_corridor(
    path: str,
    root_path: str,
    norm_exts: Set[str],
    goal_words: List[str],
    allow_appdata: bool,
) -> Tuple[str, str, List[str], List[Tuple[str, str]], int, int]:
    """
    Zero-Token Single-Folder Corridor Fast-Forward:
    If a directory has 0 matching files and exactly 1 real subfolder (e.g. C:\\Users -> eliud),
    steps locally without burning an LLM call (up to MAX_CORRIDOR_HOPS).
    Returns: (final_path, display_label, dirs, files, omitted, hops_saved)
    """
    cur_path = path
    base_name = os.path.basename(os.path.normpath(path)) or path
    label_parts = [base_name]
    hops_saved = 0

    for _ in range(MAX_CORRIDOR_HOPS):
        dirs, files, omitted = _scan_dir_metadata(cur_path, root_path, norm_exts, goal_words, allow_appdata)
        if len(dirs) == 1 and len(files) == 0 and omitted == 0:
            only_sub = dirs[0]
            next_path = os.path.join(cur_path, only_sub)
            if os.path.isdir(next_path):
                cur_path = next_path
                label_parts.append(only_sub)
                hops_saved += 1
                continue
        return cur_path, " › ".join(label_parts), dirs, files, omitted, hops_saved

    dirs, files, omitted = _scan_dir_metadata(cur_path, root_path, norm_exts, goal_words, allow_appdata)
    return cur_path, " › ".join(label_parts), dirs, files, omitted, hops_saved


# -------------------------------------------------------------------------
# HIVE-MIND SWARM RUNNER (Async Fork-Join + Live UI Tree Snapshots)
# -------------------------------------------------------------------------
class _HiveMindSwarm:
    def __init__(
        self,
        job_id: str,
        goal: str,
        start_root: str,
        extensions: List[str],
        pending_action: str,
        cancel_event: threading.Event,
    ):
        self.job_id = job_id
        self.goal = goal
        self.start_root = start_root
        self.norm_exts: Set[str] = {
            (e.lower() if e.startswith(".") else f".{e.lower()}")
            for e in (extensions or [])
            if str(e).strip()
        }
        self.goal_words = _goal_keywords(goal)
        self.allow_appdata = "appdata" in (goal or "").lower()
        self.pending_action = (pending_action or "").strip()
        self.cancel_event = cancel_event

        self.start_ts = time.perf_counter()
        self.sem = asyncio.Semaphore(MAX_CONCURRENT_AGENTS)
        self.found_event = asyncio.Event()
        self.llm_calls = 0
        self.active_agents = 0
        self.visited: Set[str] = set()
        self.near_misses: List[Dict[str, str]] = []
        self.checked_branches: List[str] = []

        self.found_path: str = ""
        self.found_name: str = ""
        self.found_node_id: str = ""

        # Live UI graph model: nodes & edges ordered by column depth
        self._node_seq = 0
        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.node_order: List[str] = []
        self.edges: List[Dict[str, str]] = []

        api_key = get_api_key() or os.getenv("OPENAI_API_KEY") or ""
        self.client = AsyncOpenAI(api_key=api_key or "missing-key")

    def _is_aborted(self) -> bool:
        return self.cancel_event.is_set() or self.found_event.is_set()

    def _add_node(
        self,
        depth: int,
        label: str,
        full_path: str,
        state: str,
        parent_id: Optional[str] = None,
        edge_state: Optional[str] = None,
    ) -> str:
        self._node_seq += 1
        nid = f"n{self._node_seq}"
        self.nodes[nid] = {
            "id": nid,
            "depth": depth,
            "label": label,
            "path": full_path,
            "state": state,
            "parentId": parent_id,
            "matchedFile": None,
        }
        self.node_order.append(nid)
        if parent_id:
            self.edges.append({
                "from": parent_id,
                "to": nid,
                "state": edge_state or state,
            })
        return nid

    def _set_node_state(self, nid: str, state: str, edge_state: Optional[str] = None) -> None:
        if nid in self.nodes:
            self.nodes[nid]["state"] = state
        for e in self.edges:
            if e["to"] == nid:
                e["state"] = edge_state or state

    def _mark_winning_chain(self, leaf_id: str, matched_name: str) -> None:
        if leaf_id in self.nodes:
            self.nodes[leaf_id]["matchedFile"] = matched_name
        cur: Optional[str] = leaf_id
        while cur and cur in self.nodes:
            self._set_node_state(cur, "found", "found")
            cur = self.nodes[cur].get("parentId")

        # Mark any still-scanning siblings as halted so UI is truthful
        for nid, n in self.nodes.items():
            if n["state"] in ("scan", "zero"):
                self._set_node_state(nid, "halt", "halt")

    def _mark_all_remaining_halted(self) -> None:
        for nid, n in self.nodes.items():
            if n["state"] in ("scan", "zero"):
                self._set_node_state(nid, "halt", "halt")

    def _build_snapshot(self, event_type: str, phase: str, bar_title: str, bar_path: str) -> Dict[str, Any]:
        # Group nodes by depth column preserving insertion order
        cols_map: Dict[int, List[Dict[str, Any]]] = {}
        for nid in self.node_order:
            n = self.nodes[nid]
            cols_map.setdefault(n["depth"], []).append({
                "id": n["id"],
                "label": n["label"],
                "state": n["state"],
                "matchedFile": n.get("matchedFile"),
            })
        columns = [cols_map[d] for d in sorted(cols_map.keys())]

        near_miss_top = self.near_misses[0] if self.near_misses else None
        return {
            "type": event_type,
            "job_id": self.job_id,
            "goal": self.goal,
            "status": phase,
            "active_agents": self.active_agents if phase == "scan" else 0,
            "found_path": self.found_path,
            "found_name": self.found_name,
            "near_miss": near_miss_top,
            "bar_title": bar_title,
            "bar_path": bar_path,
            "columns": columns,
            "edges": list(self.edges),
        }

    def _emit(self, event_type: str, phase: str, bar_title: str, bar_path: str) -> None:
        snap = self._build_snapshot(event_type, phase, bar_title, bar_path)
        with _HUNT_LOCK:
            if self.job_id in _HUNTS:
                _HUNTS[self.job_id]["snapshot"] = snap
                _HUNTS[self.job_id]["status"] = phase
                _HUNTS[self.job_id]["found_path"] = self.found_path
        _broadcast(snap)

    async def _ask_node_llm(
        self,
        path: str,
        dirs: List[str],
        files: List[Tuple[str, str]],
        omitted: int,
        dead_siblings: List[str],
        landmarks_hint: str = "",
    ) -> Dict[str, Any]:
        """Tiny stateless ~300-token structured decision call behind Semaphore(3)."""
        if self._is_aborted() or self.llm_calls >= MAX_LLM_CALLS:
            return {"decision": "dead_end", "matched_name": "", "matched_is_dir": False, "ranked_subfolders": [], "near_miss_names": []}

        async with self.sem:
            if self._is_aborted() or self.llm_calls >= MAX_LLM_CALLS:
                return {"decision": "dead_end", "matched_name": "", "matched_is_dir": False, "ranked_subfolders": [], "near_miss_names": []}

            self.llm_calls += 1
            self.active_agents += 1
            short_folder = os.path.basename(os.path.normpath(path)) or path
            self._emit(
                "file_agent_update",
                "scan",
                f"Scanning {short_folder}",
                f"{path} · 0 files read",
            )

            listing_lines = [f"[DIR] {d}" for d in dirs] + [f"[{ext}] {fn}" for fn, ext in files]
            if omitted > 0:
                listing_lines.append(f"[+{omitted} more entries omitted]")
            listing_text = "\n".join(listing_lines) if listing_lines else "[EMPTY]"

            ext_line = (
                f"Extension filter: {', '.join(sorted(self.norm_exts))}"
                if self.norm_exts
                else "Extension filter: ANY (file or folder)"
            )
            dead_line = f"\nAlready dead branches: {', '.join(dead_siblings[-6:])}" if dead_siblings else ""
            lm_block = f"\n\n{landmarks_hint}" if landmarks_hint else ""

            user_msg = (
                f"Target goal: {self.goal}\n"
                f"{ext_line}\n"
                f"Current directory: {path}{dead_line}{lm_block}\n\n"
                f"Entries in this directory:\n{listing_text}"
            )

            try:
                resp = await self.client.responses.create(
                    model=SWARM_MODEL,
                    input=[
                        {"role": "system", "content": NODE_SYSTEM_PROMPT},
                        {"role": "user", "content": user_msg},
                    ],
                    reasoning={"effort": "none"},
                    text={
                        "format": {
                            "type": "json_schema",
                            "name": "file_node_decision",
                            "strict": True,
                            "schema": DECISION_SCHEMA,
                        }
                    },
                )
                raw = (getattr(resp, "output_text", "") or "").strip()
                parsed = json.loads(raw) if raw else {}
                return parsed if isinstance(parsed, dict) else {}
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"⚠️ [FILE AGENT] Node LLM error at {path}: {exc}")
                return {"decision": "dead_end", "matched_name": "", "matched_is_dir": False, "ranked_subfolders": [], "near_miss_names": []}
            finally:
                self.active_agents = max(0, self.active_agents - 1)

    async def _explore_node(
        self,
        path: str,
        depth: int,
        parent_id: Optional[str],
        is_root: bool = False,
    ) -> Optional[str]:
        if self._is_aborted():
            return None

        norm_key = os.path.normcase(os.path.abspath(path))
        if norm_key in self.visited:
            return None
        self.visited.add(norm_key)

        # Zero-token local scan (+ single-folder corridor fast-forward on non-root nodes)
        if is_root:
            final_path = path
            display_label = f"System {path}" if len(path) <= 3 else (os.path.basename(os.path.normpath(path)) or path)
            dirs, files, omitted = await asyncio.to_thread(
                _scan_dir_metadata, path, self.start_root, self.norm_exts, self.goal_words, self.allow_appdata
            )
            hops_saved = 0
        else:
            final_path, display_label, dirs, files, omitted, hops_saved = await asyncio.to_thread(
                _fast_forward_corridor, path, self.start_root, self.norm_exts, self.goal_words, self.allow_appdata
            )
            final_key = os.path.normcase(os.path.abspath(final_path))
            self.visited.add(final_key)

        init_state = "zero" if hops_saved > 0 else "scan"
        nid = self._add_node(depth, display_label, final_path, init_state, parent_id=parent_id, edge_state=init_state)

        if is_root:
            self._emit("file_agent_start", "scan", f"Hunting for {self.goal}", f"{final_path} · 0 files read")
        else:
            self._emit("file_agent_update", "scan", f"Inspecting {display_label}", f"{final_path} · 0 files read")

        # Zero-token instant empty dead-end check (0 API calls!)
        if not dirs and not files:
            self._set_node_state(nid, "dead", "dead")
            self.checked_branches.append(display_label)
            self._emit("file_agent_update", "scan", f"Dead end: {display_label}", f"{final_path} · 0 files read")
            return None

        # Depth ceiling reached with no matching files -> dead end
        if depth >= MAX_DEPTH and not files:
            self._set_node_state(nid, "dead", "dead")
            self.checked_branches.append(display_label)
            return None

        landmarks_hint = _matching_landmarks_hint(self.goal, self.start_root) if is_root else ""
        decision_obj = await self._ask_node_llm(
            final_path,
            dirs,
            files,
            omitted,
            dead_siblings=self.checked_branches,
            landmarks_hint=landmarks_hint,
        )

        if self._is_aborted():
            self._set_node_state(nid, "halt", "halt")
            return None

        # Record any near-misses spotted by this scout
        file_names_lookup = {fn.lower(): fn for fn, _ in files}
        dir_names_lookup = {d.lower(): d for d in dirs}
        for nm in (decision_obj.get("near_miss_names") or [])[:2]:
            nm_clean = str(nm or "").strip()
            real_nm = file_names_lookup.get(nm_clean.lower()) or dir_names_lookup.get(nm_clean.lower())
            if real_nm:
                nm_full = os.path.join(final_path, real_nm)
                if os.path.exists(nm_full) and not any(x["path"] == nm_full for x in self.near_misses):
                    self.near_misses.append({"name": real_nm, "path": nm_full})

        decision = str(decision_obj.get("decision") or "dead_end").lower().strip()

        # 1. VERIFIED MATCH FOUND!
        if decision == "found":
            raw_name = str(decision_obj.get("matched_name") or "").strip()
            real_name = file_names_lookup.get(raw_name.lower()) or dir_names_lookup.get(raw_name.lower())
            if real_name:
                candidate_path = os.path.join(final_path, real_name)
                if os.path.exists(candidate_path):
                    self.found_path = candidate_path
                    self.found_name = real_name
                    self.found_node_id = nid
                    self.found_event.set()
                    self._mark_winning_chain(nid, real_name)
                    parent_for_lm = final_path if os.path.isfile(candidate_path) else candidate_path
                    _record_landmark(parent_for_lm, self.goal)
                    return candidate_path

        # 2. DEAD END
        if decision != "explore" or depth >= MAX_DEPTH:
            self._set_node_state(nid, "dead", "dead")
            self.checked_branches.append(display_label)
            self._emit("file_agent_update", "scan", f"Dead end: {display_label}", f"{final_path} · 0 files read")
            return None

        # 3. RECURSIVE FORK-JOIN WITH WAVE-1 PARALLEL + WAVE-2 ZERO-COST BACKTRACKING
        valid_targets: List[str] = []
        seen_local: Set[str] = set()
        for raw_sub in (decision_obj.get("ranked_subfolders") or []):
            real_sub = dir_names_lookup.get(str(raw_sub or "").strip().lower())
            if real_sub and real_sub.lower() not in seen_local:
                seen_local.add(real_sub.lower())
                sub_full = os.path.join(final_path, real_sub)
                if os.path.isdir(sub_full) and os.path.normcase(os.path.abspath(sub_full)) not in self.visited:
                    valid_targets.append(sub_full)

        if not valid_targets:
            self._set_node_state(nid, "dead", "dead")
            self.checked_branches.append(display_label)
            return None

        # Parent now sits waiting while children explore
        self._set_node_state(nid, "idle" if is_root else "scan")

        wave1_size = 3 if is_root else 2
        waves = [valid_targets[:wave1_size]]
        if len(valid_targets) > wave1_size:
            waves.append(valid_targets[wave1_size : wave1_size + 2])

        for wave_paths in waves:
            if self._is_aborted() or self.llm_calls >= MAX_LLM_CALLS:
                break

            tasks = [
                asyncio.create_task(self._explore_node(sp, depth + 1, parent_id=nid, is_root=False))
                for sp in wave_paths
            ]
            pending: Set[asyncio.Task] = set(tasks)
            try:
                while pending:
                    done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                    for t in done:
                        try:
                            res = t.result()
                        except asyncio.CancelledError:
                            res = None
                        except Exception:
                            res = None
                        if res:
                            # Winner found! Cancel all sibling tasks immediately!
                            for p in pending:
                                p.cancel()
                            if pending:
                                await asyncio.gather(*pending, return_exceptions=True)
                            return res
                    if self._is_aborted():
                        for p in pending:
                            p.cancel()
                        if pending:
                            await asyncio.gather(*pending, return_exceptions=True)
                        return None
            finally:
                for p in pending:
                    if not p.done():
                        p.cancel()

        # All waves under this parent failed -> bubble crimson dead-end upward!
        if not self._is_aborted():
            self._set_node_state(nid, "dead", "dead")
            self.checked_branches.append(display_label)
            self._emit("file_agent_update", "scan", f"Backtracking from {display_label}", f"{final_path} · 0 files read")
        return None

    async def run(self) -> Dict[str, Any]:
        try:
            await self._explore_node(self.start_root, depth=0, parent_id=None, is_root=True)
        except Exception as exc:
            print(f"⚠️ [FILE AGENT] Swarm run error: {exc}")
        finally:
            try:
                await self.client.close()
            except Exception:
                pass

        elapsed = time.perf_counter() - self.start_ts

        if self.found_path:
            phase = "found"
            self._emit("file_agent_done", "found", self.found_name, self.found_path)
        elif self.cancel_event.is_set():
            phase = "stopped"
            self._mark_all_remaining_halted()
            self._emit("file_agent_done", "stopped", "File search stopped", "Halted active agents cleanly")
        else:
            phase = "dead"
            nm = self.near_misses[0] if self.near_misses else None
            sub = f"Near-miss: {nm['name']} ({nm['path']})" if nm else f"Checked {len(self.checked_branches)} branches · 0 files read"
            self._emit("file_agent_done", "dead", f"No exact match on {self.start_root}", sub)

        _enqueue_hunt_completion(
            job_id=self.job_id,
            goal=self.goal,
            status=phase,
            found_path=self.found_path,
            pending_action=self.pending_action,
            checked_summary=self.checked_branches,
            near_misses=self.near_misses,
            elapsed_sec=elapsed,
        )

        return {
            "job_id": self.job_id,
            "status": phase,
            "found_path": self.found_path,
            "found_name": self.found_name,
            "near_misses": self.near_misses,
            "llm_calls": self.llm_calls,
            "elapsed_sec": round(elapsed, 2),
        }


# -------------------------------------------------------------------------
# PUBLIC THREAD-SAFE ORCHESTRATION API (Called by tools_files.py & server.py)
# -------------------------------------------------------------------------
def start_file_hunt(
    goal: str,
    extensions: Optional[List[str]] = None,
    start_root: str = "C:\\",
    pending_action: str = "",
) -> Dict[str, Any]:
    """Starts an asynchronous background Hive-Mind Swarm file hunt and returns immediately."""
    global _HUNT_COUNTER

    # Stop any prior running hunt so only one active branching canvas runs cleanly
    stop_file_hunt("")

    root_clean = (start_root or "C:\\").strip().strip('"').strip("'")
    if not os.path.isdir(root_clean):
        root_clean = "C:\\"

    cancel_event = threading.Event()
    with _HUNT_LOCK:
        _HUNT_COUNTER += 1
        job_id = f"fh-{int(time.time())}-{_HUNT_COUNTER}"
        _HUNTS[job_id] = {
            "job_id": job_id,
            "goal": goal,
            "start_root": root_clean,
            "status": "scan",
            "cancel_event": cancel_event,
            "found_path": "",
            "snapshot": None,
        }

    def _worker():
        swarm = _HiveMindSwarm(
            job_id=job_id,
            goal=goal,
            start_root=root_clean,
            extensions=extensions or [],
            pending_action=pending_action,
            cancel_event=cancel_event,
        )
        try:
            asyncio.run(swarm.run())
        except Exception as err:
            print(f"⚠️ [FILE AGENT] Thread runner error for {job_id}: {err}")

    t = threading.Thread(target=_worker, name=f"FileSwarm-{job_id}", daemon=True)
    t.start()

    return {
        "job_id": job_id,
        "start_root": root_clean,
        "goal": goal,
        "pending_action": pending_action,
    }


def stop_file_hunt(job_id: str = "") -> str:
    """Cancels an active background File Explorer Swarm hunt cleanly."""
    stopped_ids: List[str] = []
    with _HUNT_LOCK:
        targets = (
            [_HUNTS[job_id]]
            if (job_id and job_id in _HUNTS)
            else [h for h in _HUNTS.values() if h.get("status") == "scan"]
        )
        for h in targets:
            ev: Optional[threading.Event] = h.get("cancel_event")
            if ev and not ev.is_set():
                ev.set()
                stopped_ids.append(str(h.get("job_id", "")))

    if not stopped_ids:
        return "No active File Explorer search is currently running."
    return f"Stopped active File Explorer search ({', '.join(stopped_ids)})."
