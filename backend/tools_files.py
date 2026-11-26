"""
AIDEN LOCAL FILES CONNECTOR (`file_system`) — ZERO-READ PRIVACY EDITION
Provides fast, safe everyday file management without EVER reading file contents
and without EVER permanently deleting user files (Recycle Bin only).

Tools (9):
  1. file_search       — Tier 1 Instant Everything CLI (`es.exe`) search (top 3 files + 3 folders)
  2. file_agent_search — Tier 2 Async Parallel Hive-Mind Swarm explorer (delegated when Tier 1 misses)
  3. file_agent_stop   — Immediately halts an active background File Explorer Swarm
  4. file_list_dir     — Lists names, types, sizes, and modified times inside a known folder
  5. file_open         — Opens a file/folder with default app OR highlights it in File Explorer
  6. file_create       — Creates a new folder or empty placeholder file
  7. file_move         — Moves or renames a file/folder (with shorthand destination resolution)
  8. file_copy         — Copies a file/folder safely (with collision + size guardrails)
  9. file_trash        — Moves a file/folder to the Windows Recycle Bin (native Win32 SHFileOperationW)
"""

from __future__ import annotations

import concurrent.futures
import ctypes
from ctypes import wintypes
from datetime import datetime
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Tuple

try:
    import file_agent
except ImportError:
    from backend import file_agent  # type: ignore

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
MAX_COPY_FOLDER_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB safety cap for folder copies

# Noise fragments filtered from Everything (`es.exe`) results
_ES_NOISE_SUBSTRINGS = (
    "\\windows\\",
    "\\appdata\\",
    "\\programdata\\",
    "\\$recycle.bin\\",
    "\\system volume information\\",
    "\\node_modules\\",
    "\\.git\\",
    "\\__pycache__\\",
    "\\.venv\\",
    "\\venv\\",
    "\\site-packages\\",
    "\\winsxs\\",
    "\\windowsapps\\",
    "\\temp\\",
    "\\tmp\\",
)

# Hard-protected system/root paths that file_move / file_trash / file_create refuse to mutate
def _get_protected_paths() -> set:
    home = Path.home().resolve()
    protected = {
        os.path.normcase("C:\\"),
        os.path.normcase("D:\\"),
        os.path.normcase("E:\\"),
        os.path.normcase("C:\\Windows"),
        os.path.normcase("C:\\Program Files"),
        os.path.normcase("C:\\Program Files (x86)"),
        os.path.normcase("C:\\ProgramData"),
        os.path.normcase("C:\\Users"),
        os.path.normcase(str(home)),
    }
    for sub in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "OneDrive"):
        p = home / sub
        protected.add(os.path.normcase(str(p)))
        od = home / "OneDrive" / sub
        protected.add(os.path.normcase(str(od)))
    return protected


def _is_protected_target(target_path: str) -> bool:
    """Blocks destructive moves/deletes on drive roots, Windows system roots, or top user folders."""
    norm = os.path.normcase(os.path.abspath(target_path))
    if len(norm) <= 3 and norm.endswith("\\"):
        return True
    if norm in _get_protected_paths():
        return True
    for sys_prefix in ("c:\\windows\\", "c:\\program files\\", "c:\\program files (x86)\\", "c:\\programdata\\"):
        if norm.startswith(sys_prefix):
            return True
    return False


def _resolve_known_folder(name: str) -> Optional[Path]:
    """Resolves Windows Known Folders, respecting OneDrive Desktop/Documents redirection."""
    home = Path.home()
    key = name.strip().lower().rstrip("\\/")
    known = {
        "desktop": "Desktop",
        "downloads": "Downloads",
        "documents": "Documents",
        "docs": "Documents",
        "pictures": "Pictures",
        "photos": "Pictures",
        "videos": "Videos",
        "music": "Music",
    }
    if key in ("home", "userprofile", "~"):
        return home
    if key in ("onedrive",):
        od = home / "OneDrive"
        return od if od.is_dir() else None
    if key in ("my projects", "projects"):
        mp = Path("C:\\My Projects")
        if mp.is_dir():
            return mp
        hp = home / "Projects"
        return hp if hp.is_dir() else None
    if key in ("c", "c:", "c:\\", "c drive", "system c"):
        return Path("C:\\")
    if len(key) == 2 and key[1] == ":" and key[0].isalpha():
        drv = Path(f"{key[0].upper()}:\\")
        return drv if drv.is_dir() else None

    sub = known.get(key)
    if not sub:
        return None
    # Prefer local user folder if it exists & is non-empty, else check OneDrive redirected folder
    direct = home / sub
    onedrive_sub = home / "OneDrive" / sub
    if onedrive_sub.is_dir() and not direct.is_dir():
        return onedrive_sub
    if direct.is_dir():
        return direct
    if onedrive_sub.is_dir():
        return onedrive_sub
    return direct


def _resolve_path_input(raw_path: str) -> Path:
    """Expands shorthand prefixes (e.g. 'Desktop/Receipts' or 'Downloads') into full Windows Paths."""
    cleaned = (raw_path or "").strip().strip('"').strip("'")
    if not cleaned:
        return Path.home()

    direct_known = _resolve_known_folder(cleaned)
    if direct_known is not None:
        return direct_known

    # Support shorthand prefixes like "Desktop/Calendar.pdf" or "Documents\\School"
    normalized = cleaned.replace("/", "\\")
    parts = normalized.split("\\", 1)
    if len(parts) == 2:
        prefix_folder = _resolve_known_folder(parts[0])
        if prefix_folder is not None:
            return prefix_folder / parts[1]

    expanded = os.path.expandvars(os.path.expanduser(cleaned))
    return Path(expanded)


def _format_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    if num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    return f"{num_bytes / (1024 * 1024 * 1024):.2f} GB"


def _format_mtime(ts: float) -> str:
    try:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


# -------------------------------------------------------------------------
# 1. TIER 1 — INSTANT LOCAL INDEX SEARCH VIA EVERYTHING CLI (`es.exe`)
# -------------------------------------------------------------------------
_ES_EXE_CACHE: Optional[str] = None
_ES_CHECKED = False


def _find_es_exe() -> Optional[str]:
    global _ES_EXE_CACHE, _ES_CHECKED
    if _ES_CHECKED:
        return _ES_EXE_CACHE
    _ES_CHECKED = True

    candidates: List[Path] = []
    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        candidates.append(Path(local_app) / "Microsoft" / "WindowsApps" / "es.exe")
    which_es = shutil.which("es.exe") or shutil.which("es")
    if which_es:
        candidates.append(Path(which_es))
    candidates.extend([
        Path(r"C:\Program Files\Everything\es.exe"),
        Path(r"C:\Program Files (x86)\Everything\es.exe"),
    ])
    for c in candidates:
        if c.is_file():
            _ES_EXE_CACHE = str(c)
            return _ES_EXE_CACHE
    return None


def _run_es_pass(es_path: str, attr_flag: str, terms: List[str], limit: int = 50) -> Optional[List[str]]:
    """Executes one Everything CLI pass (`/a-d` files or `/ad` folders). Returns None if IPC offline."""
    cmd = [es_path, attr_flag, "-n", str(limit), "-sort", "run-count-descending", *terms]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2.5,
            creationflags=CREATE_NO_WINDOW,
        )
        if proc.returncode == 8:
            # Everything IPC service not running
            return None
        if proc.returncode != 0 and not proc.stdout.strip():
            return []
        return [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    except Exception:
        return None


def _score_es_candidate(path_str: str, query_tokens: List[str], home_lower: str) -> int:
    pl = path_str.lower()
    if any(noise in pl for noise in _ES_NOISE_SUBSTRINGS):
        return -1000
    name_l = os.path.basename(path_str).lower()
    score = 10
    if name_l.startswith(".".lower()):
        return -1000

    # User-space folders strongly preferred
    if pl.startswith(home_lower):
        score += 35
        for hot in ("\\desktop\\", "\\documents\\", "\\downloads\\", "\\pictures\\", "\\videos\\", "\\onedrive\\"):
            if hot in pl:
                score += 18
                break
    elif pl.startswith("c:\\my projects\\"):
        score += 32

    # Exact/prefix name match boost
    joined = " ".join(query_tokens)
    stem = os.path.splitext(name_l)[0]
    if stem == joined or name_l == joined:
        score += 60
    elif stem.startswith(joined):
        score += 30

    matched_toks = sum(1 for t in query_tokens if t in name_l)
    score += matched_toks * 14

    # Shorter paths slightly preferred over deeply buried build caches
    depth = pl.count("\\")
    score -= max(0, depth - 5) * 2
    return score


def file_search(
    query: str,
    extension: str = "",
    location_hint: str = "",
    item_type: str = "both",
) -> str:
    """
    Tier 1 Instant Search via Voidtools Everything (`es.exe`).
    Returns up to 6 clean options: top 3 Files + top 3 Folders with exact full paths & metadata.
    Never reads file contents.
    """
    clean_q = (query or "").strip()
    clean_ext = (extension or "").strip().lstrip(".").lower()
    clean_loc = (location_hint or "").strip()
    mode = (item_type or "both").strip().lower()

    if not clean_q and not clean_ext:
        return "Error: Please provide a search query or file extension."

    es_path = _find_es_exe()
    if not es_path:
        return (
            "[TIER 1 UNAVAILABLE] Everything CLI (es.exe) is not installed on this PC. "
            "Tell the user you are delegating to your secondary File Explorer agents and call "
            "`file_agent_search` now."
        )

    tokens = [t for t in clean_q.split() if t]
    file_terms = list(tokens)
    folder_terms = list(tokens)

    if clean_ext:
        file_terms.append(f"ext:{clean_ext}")
    if clean_loc:
        loc_dir = _resolve_known_folder(clean_loc)
        loc_str = str(loc_dir) if loc_dir else clean_loc
        file_terms.append(f'"{loc_str}"')
        folder_terms.append(f'"{loc_str}"')

    want_files = mode in ("both", "files", "file")
    want_folders = mode in ("both", "folders", "folder") and not clean_ext

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        f_fut = pool.submit(_run_es_pass, es_path, "/a-d", file_terms, 50) if want_files else None
        d_fut = pool.submit(_run_es_pass, es_path, "/ad", folder_terms, 50) if want_folders else None
        raw_files = f_fut.result() if f_fut else []
        raw_folders = d_fut.result() if d_fut else []

    if (want_files and raw_files is None) and (not want_folders or raw_folders is None):
        return (
            "[TIER 1 OFFLINE] Everything index service is currently not running. "
            "Tell the user you are delegating to your secondary File Explorer agents and call "
            "`file_agent_search` now."
        )

    home_lower = str(Path.home()).lower()
    q_low = [t.lower() for t in tokens]

    def _pick_top(raw_list: Optional[List[str]], limit: int) -> List[str]:
        if not raw_list:
            return []
        scored: List[Tuple[int, str]] = []
        seen: set = set()
        for p in raw_list:
            nk = os.path.normcase(p)
            if nk in seen or not os.path.exists(p):
                continue
            seen.add(nk)
            sc = _score_es_candidate(p, q_low, home_lower)
            if sc > 0:
                scored.append((sc, p))
        scored.sort(key=lambda x: (-x[0], len(x[1])))
        return [p for _, p in scored[:limit]]

    top_files = _pick_top(raw_files, 3 if want_folders else 6)
    top_folders = _pick_top(raw_folders, 3 if want_files else 6)

    if not top_files and not top_folders:
        return (
            f"[TIER 1 MISS] Instant index found 0 clean matches for '{clean_q}'"
            f"{f' (.{clean_ext})' if clean_ext else ''}. "
            "Tell the user you couldn't spot it in the quick index and are delegating to your "
            "secondary File Explorer agents, then call `file_agent_search` now (preserving any "
            "follow-up action like moving/copying in `pending_action`)."
        )

    lines = [f"[TIER 1 INSTANT INDEX RESULTS for '{clean_q}' — metadata only, 0 files read]"]
    if top_files:
        lines.append("\nTOP FILES (up to 3):")
        for idx, fp in enumerate(top_files, start=1):
            try:
                st = os.stat(fp)
                meta = f"{_format_size(st.st_size)} | modified {_format_mtime(st.st_mtime)}"
            except OSError:
                meta = "file"
            parent = os.path.dirname(fp)
            lines.append(f"  {idx}. {os.path.basename(fp)} | PATH: {fp} | FOLDER: {parent} ({meta})")
    if top_folders:
        lines.append("\nTOP FOLDERS (up to 3):")
        for idx, dp in enumerate(top_folders, start=1):
            parent = os.path.dirname(dp)
            lines.append(f"  {idx}. {os.path.basename(dp)} [FOLDER] | PATH: {dp} | PARENT: {parent}")

    lines.append(
        "\nNOTE: If one of these matches what the user asked for, you may act on it immediately "
        "(e.g. `file_move`, `file_copy`, `file_open`, `file_trash`). If NONE of these look right, "
        "delegate to `file_agent_search` to hunt across directories."
    )
    return "\n".join(lines)


# -------------------------------------------------------------------------
# 2 & 3. TIER 2 — ASYNC PARALLEL HIVE-MIND SWARM DELEGATION & STOP
# -------------------------------------------------------------------------
def file_agent_search(
    goal: str,
    extensions: Optional[List[str]] = None,
    start_root: str = "C:\\",
    pending_action: str = "",
) -> str:
    """Launches the async Tier 2 Hive-Mind Swarm File Explorer in the background."""
    clean_goal = (goal or "").strip()
    if not clean_goal:
        return "Error: Please provide a target file or folder description in `goal`."

    resolved_root = str(_resolve_path_input(start_root)) if (start_root or "").strip() else "C:\\"
    if not os.path.isdir(resolved_root):
        resolved_root = "C:\\"

    info = file_agent.start_file_hunt(
        goal=clean_goal,
        extensions=extensions or [],
        start_root=resolved_root,
        pending_action=pending_action or "",
    )
    return (
        f"[FILE AGENT LAUNCHED - {info['job_id']}]\n"
        f"Secondary parallel File Explorer agents are now hunting across '{info['start_root']}' "
        f"for '{info['goal']}' (strictly metadata-only, 0 files read). The live branching glass card "
        f"is streaming on screen right now.\n"
        f"Reply in ONE brief, natural sentence letting the user know you've dispatched your File Explorer "
        f"agents and will jump right back in as soon as they spot it. Do NOT call any more tools in this turn."
    )


def file_agent_stop(job_id: str = "") -> str:
    """Stops any running background File Explorer Swarm search cleanly."""
    return file_agent.stop_file_hunt(job_id or "")


# -------------------------------------------------------------------------
# 4. METADATA-ONLY DIRECTORY LISTING (NO FILE READING)
# -------------------------------------------------------------------------
def file_list_dir(folder_path: str, max_items: int = 50) -> str:
    """Lists subfolders and filenames inside a known directory (names, sizes, timestamps — zero reads)."""
    target = _resolve_path_input(folder_path)
    if not target.exists():
        return f"Error: Folder not found at '{target}'."
    if not target.is_dir():
        return f"Error: '{target}' is a file, not a folder."

    cap = max(1, min(120, int(max_items or 50)))
    dirs: List[Tuple[str, str]] = []
    files: List[Tuple[str, str, str]] = []

    try:
        with os.scandir(target) as it:
            for entry in it:
                if entry.name.startswith("."):
                    continue
                try:
                    st = entry.stat(follow_symlinks=False)
                    mtime = _format_mtime(st.st_mtime)
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append((entry.name, mtime))
                    else:
                        files.append((entry.name, _format_size(st.st_size), mtime))
                except OSError:
                    continue
    except PermissionError:
        return f"Error: Access denied reading directory listing for '{target}'."
    except Exception as exc:
        return f"Error listing directory '{target}': {exc}"

    dirs.sort(key=lambda x: x[0].lower())
    files.sort(key=lambda x: x[0].lower())

    lines = [f"[DIRECTORY LISTING: {target} — {len(dirs)} folders, {len(files)} files (metadata only)]"]
    shown = 0
    for dname, mtime in dirs:
        if shown >= cap:
            break
        lines.append(f"  [DIR]  {dname}  (modified {mtime})")
        shown += 1
    for fname, sz, mtime in files:
        if shown >= cap:
            break
        lines.append(f"  [FILE] {fname}  ({sz}, modified {mtime})")
        shown += 1

    remaining = (len(dirs) + len(files)) - shown
    if remaining > 0:
        lines.append(f"  ... (+{remaining} more items)")
    return "\n".join(lines)


# -------------------------------------------------------------------------
# 5. OPEN / REVEAL IN WINDOWS FILE EXPLORER
# -------------------------------------------------------------------------
def _reveal_via_shell_api(resolved_path: str) -> bool:
    """Uses native Win32 SHOpenFolderAndSelectItems to highlight an item without CLI quoting bugs."""
    if os.name != "nt":
        return False
    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32

    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None

    shell32.ILCreateFromPathW.argtypes = [wintypes.LPCWSTR]
    shell32.ILCreateFromPathW.restype = ctypes.c_void_p
    shell32.SHOpenFolderAndSelectItems.argtypes = [
        ctypes.c_void_p,
        wintypes.UINT,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    shell32.SHOpenFolderAndSelectItems.restype = ctypes.c_long
    shell32.ILFree.argtypes = [ctypes.c_void_p]
    shell32.ILFree.restype = None

    did_init = False
    pidl = None
    try:
        hr_init = ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
        did_init = hr_init in (0, 1)
        pidl = shell32.ILCreateFromPathW(resolved_path)
        if not pidl:
            return False
        hr = shell32.SHOpenFolderAndSelectItems(pidl, 0, None, 0)
        return hr == 0
    except Exception:
        return False
    finally:
        if pidl:
            try:
                shell32.ILFree(pidl)
            except Exception:
                pass
        if did_init:
            try:
                ole32.CoUninitialize()
            except Exception:
                pass


def file_open(path: str, mode: str = "open") -> str:
    """Opens a file/folder ('open') or highlights a file / opens a folder in Explorer ('reveal')."""
    target = _resolve_path_input(path)
    if not target.exists():
        return f"Error: Path does not exist: '{target}'."

    resolved = str(target.resolve())
    clean_mode = (mode or "open").strip().lower()
    try:
        # When revealing/opening a directory itself, open straight inside it in File Explorer
        if target.is_dir():
            os.startfile(resolved)
            return f"Opened folder '{target.name}' in File Explorer ({resolved})."

        if clean_mode in ("reveal", "show", "folder", "explorer"):
            if not _reveal_via_shell_api(resolved):
                # Important: keep `/select,` UNQUOTED before the quoted path (Explorer CLI requirement)
                subprocess.Popen(
                    f'explorer.exe /select,"{resolved}"',
                    creationflags=CREATE_NO_WINDOW,
                )
            return f"Highlighted '{target.name}' in Windows File Explorer ({resolved})."

        os.startfile(resolved)
        return f"Opened '{target.name}' ({resolved})."
    except Exception as exc:
        return f"Error opening '{target}': {exc}"


# -------------------------------------------------------------------------
# 6. CREATE FOLDER OR EMPTY PLACEHOLDER FILE
# -------------------------------------------------------------------------
def file_create(path: str, item_type: str = "folder") -> str:
    """Creates a new folder or an empty placeholder file. Never overwrites existing items."""
    target = _resolve_path_input(path)
    if _is_protected_target(str(target)):
        return f"Safety block: Refusing to create inside protected system path '{target}'."
    if target.exists():
        return f"Error: '{target}' already exists."

    kind = (item_type or "folder").strip().lower()
    try:
        if kind in ("folder", "dir", "directory"):
            target.mkdir(parents=True, exist_ok=False)
            return f"Created folder: {target.resolve()}"
        elif kind == "file":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch(exist_ok=False)
            return f"Created empty file: {target.resolve()}"
        else:
            return f"Error: Invalid item_type '{item_type}'. Use 'folder' or 'file'."
    except Exception as exc:
        return f"Error creating '{target}': {exc}"


# -------------------------------------------------------------------------
# 7. MOVE OR RENAME FILE / FOLDER
# -------------------------------------------------------------------------
def file_move(source_path: str, destination: str) -> str:
    """Moves or renames a file or folder. Automatically resolves shorthand destinations like 'Desktop'."""
    src = _resolve_path_input(source_path)
    if not src.exists():
        return f"Error: Source path not found: '{src}'."
    if _is_protected_target(str(src)):
        return f"Safety block: Refusing to move protected system or root folder '{src}'."

    dest_raw = (destination or "").strip().strip('"').strip("'")
    if not dest_raw:
        return "Error: Destination path or new name is required."

    # If user supplied just a plain new filename with no slashes and not a known folder -> rename in place
    known_dest = _resolve_known_folder(dest_raw)
    if known_dest is not None:
        dest = known_dest / src.name
    elif "\\" not in dest_raw and "/" not in dest_raw and ":" not in dest_raw:
        dest = src.parent / dest_raw
    else:
        cand = _resolve_path_input(dest_raw)
        dest = (cand / src.name) if cand.is_dir() else cand

    if _is_protected_target(str(dest)):
        return f"Safety block: Refusing to move into protected system path '{dest}'."
    if dest.exists():
        return f"Error: Destination already exists at '{dest}'. Pick another name or destination to avoid overwriting."

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src.resolve()), str(dest))
        return f"Moved '{src.name}' to '{dest.resolve()}'."
    except Exception as exc:
        return f"Error moving '{src}' to '{dest}': {exc}"


# -------------------------------------------------------------------------
# 8. COPY FILE OR FOLDER (WITH SIZE & COLLISION GUARDRAILS)
# -------------------------------------------------------------------------
def _dir_size_bounded(folder: Path, limit_bytes: int) -> int:
    total = 0
    for root, _, filenames in os.walk(folder):
        for fn in filenames:
            try:
                total += os.path.getsize(os.path.join(root, fn))
                if total > limit_bytes:
                    return total
            except OSError:
                pass
    return total


def file_copy(source_path: str, destination: str) -> str:
    """Copies a file or folder to a destination (with shorthand resolution & 2GB folder guardrail)."""
    src = _resolve_path_input(source_path)
    if not src.exists():
        return f"Error: Source path not found: '{src}'."

    dest_raw = (destination or "").strip().strip('"').strip("'")
    if not dest_raw:
        return "Error: Destination path is required."

    known_dest = _resolve_known_folder(dest_raw)
    if known_dest is not None:
        dest = known_dest / src.name
    elif "\\" not in dest_raw and "/" not in dest_raw and ":" not in dest_raw:
        dest = src.parent / dest_raw
    else:
        cand = _resolve_path_input(dest_raw)
        dest = (cand / src.name) if cand.is_dir() else cand

    if _is_protected_target(str(dest)):
        return f"Safety block: Refusing to copy into protected system path '{dest}'."
    if dest.exists():
        return f"Error: Destination already exists at '{dest}'. Choose a different name to avoid overwriting."

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            est = _dir_size_bounded(src, MAX_COPY_FOLDER_BYTES)
            if est > MAX_COPY_FOLDER_BYTES:
                return f"Safety block: Folder '{src.name}' exceeds 2 GB — refusing accidental massive copy."
            shutil.copytree(str(src.resolve()), str(dest))
        else:
            shutil.copy2(str(src.resolve()), str(dest))
        return f"Copied '{src.name}' to '{dest.resolve()}'."
    except Exception as exc:
        return f"Error copying '{src}' to '{dest}': {exc}"


# -------------------------------------------------------------------------
# 9. SAFE RECYCLE BIN TRASH (NATIVE WIN32 SHFileOperationW — ZERO PERMANENT DELETE!)
# -------------------------------------------------------------------------
class _SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", wintypes.UINT),
        ("pFrom", wintypes.LPCWSTR),
        ("pTo", wintypes.LPCWSTR),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", wintypes.LPCWSTR),
    ]


def file_trash(path: str) -> str:
    """Safely moves a file or folder to the Windows Recycle Bin (100% recoverable; never permanently deletes)."""
    target = _resolve_path_input(path)
    if not target.exists():
        return f"Error: Path not found: '{target}'."
    resolved = str(target.resolve())
    if _is_protected_target(resolved):
        return f"Safety block: Refusing to delete protected system or root folder '{resolved}'."

    FO_DELETE = 3
    FOF_SILENT = 0x0004
    FOF_NOCONFIRMATION = 0x0010
    FOF_ALLOWUNDO = 0x0040
    FOF_NOERRORUI = 0x0400

    op = _SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = resolved + "\0\0"  # Double-null terminated required by Win32 SHFileOperationW
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI

    try:
        res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        if res != 0 or op.fAnyOperationsAborted:
            return f"Error moving '{target.name}' to Recycle Bin (Win32 code {res})."
        return f"Moved '{target.name}' to the Windows Recycle Bin ({resolved})."
    except Exception as exc:
        return f"Error moving '{target}' to Recycle Bin: {exc}"


# -------------------------------------------------------------------------
# OPENAI RESPONSES API FLAT TOOL SCHEMAS & REGISTRY EXPORT
# -------------------------------------------------------------------------
FILES_TOOLS_SCHEMA: List[Dict[str, Any]] = [
    {
        "type": "function",
        "name": "file_search",
        "description": (
            "Tier 1 instant local index search (Voidtools Everything) returning up to 6 clean options "
            "(top 3 files + top 3 folders) with exact full paths and metadata. NEVER reads file contents. "
            "ALWAYS call this FIRST when locating a local file or folder. If it returns [TIER 1 MISS] or "
            "[TIER 1 OFFLINE/UNAVAILABLE], delegate to `file_agent_search`."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Filename or folder keywords (e.g. 'calendar', 'DS4 windows', 'resume').",
                },
                "extension": {
                    "type": "string",
                    "description": "Optional file extension filter without dot (e.g. 'pdf', 'mp4', 'docx'). Leave empty if searching folders or unknown type.",
                },
                "location_hint": {
                    "type": "string",
                    "description": "Optional folder hint (e.g. 'Desktop', 'Downloads', 'Documents', 'My Projects').",
                },
                "item_type": {
                    "type": "string",
                    "enum": ["both", "files", "folders"],
                    "description": "Filter by 'both' (default: top 3 files + 3 folders), 'files', or 'folders'.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_agent_search",
        "description": (
            "Tier 2 asynchronous parallel Hive-Mind Swarm file explorer. Use ONLY when `file_search` "
            "misses, is offline, or the user gave a vague/conceptual description. Dispatches parallel "
            "metadata-only sub-agents across directories with a live branching glass UI and wakes you "
            "automatically when found. NEVER reads file contents."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "Natural description of the target file or folder to hunt for (e.g. '2026 calendar PDF', 'DS4 controller setup folder').",
                },
                "extensions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of file extensions ONLY if user specified them (e.g. ['pdf']). Pass [] for folders or unspecified types.",
                },
                "start_root": {
                    "type": "string",
                    "description": "Starting root drive or folder (defaults to 'C:\\'; use 'D:\\' or 'Documents' only if user specified).",
                },
                "pending_action": {
                    "type": "string",
                    "description": "Optional follow-up action requested by the user once found (e.g. 'move it to Desktop', 'open it', 'copy to Downloads').",
                },
            },
            "required": ["goal"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_agent_stop",
        "description": "Immediately stops an active background File Explorer Swarm search.",
        "parameters": {
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "Optional job_id to stop (leave empty to stop the currently running search).",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_list_dir",
        "description": (
            "Lists folder and file names (plus sizes and modified dates) inside a known local directory. "
            "Supports Windows shorthand like 'Desktop', 'Downloads', 'Documents', 'Pictures', 'My Projects'. "
            "Strictly metadata-only — never reads file contents."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "folder_path": {
                    "type": "string",
                    "description": "Full path or shorthand folder name (e.g. 'Desktop', 'Downloads', 'C:\\My Projects').",
                },
                "max_items": {
                    "type": "integer",
                    "description": "Max entries to return (default 50, max 120).",
                },
            },
            "required": ["folder_path"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_open",
        "description": "Opens a local folder in File Explorer or launches a file with its default app ('open'), OR highlights a specific file inside its parent folder in Windows File Explorer ('reveal').",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Full path (or shorthand like 'Desktop/report.pdf') to open or reveal.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["open", "reveal"],
                    "description": "'open' launches with default app; 'reveal' opens Windows File Explorer highlighting the item.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_create",
        "description": "Creates a new folder (default) or an empty placeholder file. Never overwrites existing items.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Full path or shorthand path to create (e.g. 'Desktop/Receipts', 'Documents/Todo.txt').",
                },
                "item_type": {
                    "type": "string",
                    "enum": ["folder", "file"],
                    "description": "'folder' (default) to create a directory, or 'file' for an empty placeholder file.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_move",
        "description": (
            "Moves or renames a local file or folder. Automatically resolves shorthand destinations "
            "like 'Desktop', 'Downloads', or 'Documents'. Refuses to overwrite existing files."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "source_path": {
                    "type": "string",
                    "description": "Exact path of the existing file or folder to move or rename.",
                },
                "destination": {
                    "type": "string",
                    "description": "Target folder shorthand ('Desktop', 'Downloads'), full target path, or new filename to rename in place.",
                },
            },
            "required": ["source_path", "destination"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_copy",
        "description": "Copies a local file or folder to a destination path or shorthand folder (e.g. 'Desktop'). Refuses to overwrite existing items.",
        "parameters": {
            "type": "object",
            "properties": {
                "source_path": {
                    "type": "string",
                    "description": "Exact path of the file or folder to copy.",
                },
                "destination": {
                    "type": "string",
                    "description": "Target folder shorthand ('Desktop', 'Documents'), full destination path, or new filename.",
                },
            },
            "required": ["source_path", "destination"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "file_trash",
        "description": "Safely deletes a file or folder by moving it to the Windows Recycle Bin (100% recoverable; never permanently deletes).",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Exact path of the file or folder to move to the Recycle Bin.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
]

FILES_TOOLS: Dict[str, Any] = {
    "file_search": file_search,
    "file_agent_search": file_agent_search,
    "file_agent_stop": file_agent_stop,
    "file_list_dir": file_list_dir,
    "file_open": file_open,
    "file_create": file_create,
    "file_move": file_move,
    "file_copy": file_copy,
    "file_trash": file_trash,
}
