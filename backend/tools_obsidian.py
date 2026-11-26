"""
AIDEN OBSIDIAN NOTES VAULT CONNECTOR TOOLS
Direct local integration with Obsidian Markdown vaults on Windows.
Zero external pip dependencies (standard library only).

AVAILABLE OBSIDIAN TOOLS:
- get_obsidian_vaults
- scan_obsidian_vault
- search_obsidian_notes
- read_obsidian_note
- modify_obsidian_note
- open_obsidian_note
- map_obsidian_graph
"""

import json
import os
import re
import urllib.parse
from typing import Optional

_IGNORE_DIRS = {".obsidian", ".trash", ".git", "node_modules"}
_WIKILINK_PATTERN = re.compile(r"\[\[(.*?)\]\]")


def _resolve_vault_file(
    vault_path: str,
    relative_path: str,
    *,
    auto_md: bool = True,
    must_exist: bool = False,
) -> tuple[Optional[str], Optional[str]]:
    """
    Safely resolves a relative note path inside `vault_path`, blocking `../` traversal.
    Returns `(abs_path, error_message)`.
    """
    if not vault_path or not os.path.isdir(vault_path):
        return None, f"Error: The vault path '{vault_path}' does not exist or is invalid."
    if not relative_path or not relative_path.strip():
        return None, "Error: relative_path is required."

    clean_rel = relative_path.strip().lstrip("/\\")
    vault_real = os.path.realpath(vault_path)
    candidate = os.path.realpath(os.path.join(vault_real, clean_rel))

    try:
        if os.path.commonpath([vault_real, candidate]) != vault_real:
            return None, f"Error: Access denied — '{relative_path}' resolves outside the vault."
    except ValueError:
        return None, f"Error: Access denied — '{relative_path}' is on a different drive than the vault."

    if auto_md and not os.path.exists(candidate) and not candidate.lower().endswith(".md"):
        md_candidate = candidate + ".md"
        if not must_exist or os.path.exists(md_candidate):
            candidate = md_candidate

    if must_exist and not os.path.isfile(candidate):
        return None, f"Error: Note not found at '{relative_path}' inside vault '{vault_path}'."

    return candidate, None


def get_obsidian_vaults(**kwargs) -> str:
    """
    Instantly discovers all local Obsidian vaults by reading the native AppData config.
    """
    appdata = os.getenv("APPDATA")
    if not appdata:
        return "Error: Could not locate APPDATA environment variable."

    config_path = os.path.join(appdata, "obsidian", "obsidian.json")
    if not os.path.exists(config_path):
        return "Obsidian does not appear to be installed or no vaults have been created yet."

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        vaults_dict = data.get("vaults", {})
        if not vaults_dict:
            return "No Obsidian vaults found in the configuration."

        lines = ["--- DISCOVERED OBSIDIAN VAULTS ---"]
        found_target = False
        valid_count = 0

        for _vault_id, vault_info in vaults_dict.items():
            v_path = vault_info.get("path", "")
            if not v_path:
                continue
            v_path = os.path.normpath(v_path)
            if not os.path.isdir(v_path):
                continue

            valid_count += 1
            v_name = os.path.basename(v_path)
            is_open = bool(vault_info.get("open", False))
            open_tag = " [OPEN]" if is_open else ""

            if "aiden-vault" in v_name.lower():
                found_target = True
                lines.append(f"🎯 [ACTIVE_TARGET]{open_tag} Vault: '{v_name}' | Path: {v_path}")
            else:
                lines.append(f"📁{open_tag} Vault: '{v_name}' | Path: {v_path}")

        if valid_count == 0:
            return "No existing Obsidian vault directories were found on disk."

        if found_target:
            lines.append("\nSYSTEM NOTE: The 'aiden-vault' was successfully auto-discovered!")

        return "\n".join(lines)

    except Exception as e:
        return f"Error reading Obsidian config: {str(e)}"


def scan_obsidian_vault(**kwargs) -> str:
    """
    Instantly maps out all folders and Markdown (.md) files in a given Obsidian vault.
    """
    vault_path = (kwargs.get("vault_path") or "").strip()
    subfolder = (kwargs.get("subfolder") or "").strip().lstrip("/\\")

    if not vault_path or not os.path.isdir(vault_path):
        return f"Error: The vault path '{vault_path}' does not exist or is invalid."

    vault_real = os.path.realpath(vault_path)
    scan_root = vault_real
    if subfolder:
        candidate = os.path.realpath(os.path.join(vault_real, subfolder))
        try:
            if os.path.commonpath([vault_real, candidate]) != vault_real:
                return f"Error: Access denied — subfolder '{subfolder}' resolves outside the vault."
        except ValueError:
            return f"Error: Invalid subfolder '{subfolder}'."
        if not os.path.isdir(candidate):
            return f"Error: Subfolder '{subfolder}' does not exist inside the vault."
        scan_root = candidate

    print(f"\n🧠 [OBSIDIAN] Scanning vault tree at: {scan_root}...")
    tree_output = []

    try:
        for root, dirs, files in os.walk(scan_root):
            dirs[:] = sorted(d for d in dirs if d not in _IGNORE_DIRS)
            rel_root = os.path.relpath(root, vault_real)
            if rel_root == ".":
                rel_root = ""

            for d in dirs:
                dir_path = os.path.join(rel_root, d).replace("\\", "/")
                tree_output.append(f"[DIR]  {dir_path}")

            for f in sorted(files):
                if f.lower().endswith(".md"):
                    file_path = os.path.join(rel_root, f).replace("\\", "/")
                    tree_output.append(f"[FILE] {file_path}")

        if not tree_output:
            return f"The vault at '{vault_path}' is empty or contains no Markdown files."

        final_output = f"--- OBSIDIAN VAULT INDEX: {os.path.basename(vault_real)} ---\n"
        final_output += "\n".join(tree_output)
        final_output += (
            "\n\nSYSTEM NOTE: Use these exact relative [FILE] paths combined with "
            "the vault_path to read, modify, or open notes."
        )
        return final_output

    except Exception as e:
        return f"Error scanning Obsidian vault: {str(e)}"


def search_obsidian_notes(**kwargs) -> str:
    """
    Fast case-insensitive search across note titles/paths and Markdown body content.
    Returns matching relative paths with brief line snippets.
    """
    vault_path = (kwargs.get("vault_path") or "").strip()
    query = (kwargs.get("query") or "").strip()
    try:
        max_results = max(1, min(25, int(kwargs.get("max_results", 10))))
    except Exception:
        max_results = 10

    if not vault_path or not os.path.isdir(vault_path):
        return f"Error: The vault path '{vault_path}' does not exist or is invalid."
    if not query:
        return "Error: query is required to search Obsidian notes."

    print(f"\n🔎 [OBSIDIAN] Searching '{query}' in: {vault_path}...")
    q_lower = query.lower()
    vault_real = os.path.realpath(vault_path)
    matches = []

    try:
        for root, dirs, files in os.walk(vault_real):
            dirs[:] = sorted(d for d in dirs if d not in _IGNORE_DIRS)
            rel_root = os.path.relpath(root, vault_real)
            if rel_root == ".":
                rel_root = ""

            for f in sorted(files):
                if not f.lower().endswith(".md"):
                    continue
                full_path = os.path.join(root, f)
                rel_path = os.path.join(rel_root, f).replace("\\", "/")
                title_hit = q_lower in rel_path.lower()
                snippets = []

                try:
                    with open(full_path, "r", encoding="utf-8", errors="replace") as fh:
                        for line_no, line in enumerate(fh, start=1):
                            if q_lower in line.lower():
                                cleaned = line.strip()
                                if len(cleaned) > 160:
                                    cleaned = cleaned[:157] + "..."
                                snippets.append(f"L{line_no}: {cleaned}")
                                if len(snippets) >= 3:
                                    break
                except Exception:
                    continue

                if title_hit or snippets:
                    score = (2 if title_hit else 0) + len(snippets)
                    matches.append((score, rel_path, title_hit, snippets))

        if not matches:
            return f"No Obsidian notes matched '{query}' in '{os.path.basename(vault_real)}'."

        matches.sort(key=lambda item: (-item[0], item[1].lower()))
        top = matches[:max_results]
        lines = [
            f"--- OBSIDIAN SEARCH RESULTS for '{query}' "
            f"({len(top)} of {len(matches)} matching note(s)) ---"
        ]
        for _score, rel_path, title_hit, snippets in top:
            badge = " [TITLE MATCH]" if title_hit else ""
            lines.append(f"[FILE] {rel_path}{badge}")
            for snip in snippets:
                lines.append(f"    {snip}")

        return "\n".join(lines)

    except Exception as e:
        return f"Error searching Obsidian notes: {str(e)}"


def read_obsidian_note(**kwargs) -> str:
    """Reads the raw Markdown content of an Obsidian note without truncation."""
    vault_path = (kwargs.get("vault_path") or "").strip()
    relative_path = (kwargs.get("relative_path") or "").strip()

    file_path, err = _resolve_vault_file(vault_path, relative_path, auto_md=True, must_exist=True)
    if err or not file_path:
        return err or "Error: Invalid note path."

    try:
        rel_display = os.path.relpath(file_path, os.path.realpath(vault_path)).replace("\\", "/")
        print(f"\n📖 [OBSIDIAN] Reading note: {rel_display}...")
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        return f"--- CONTENT OF {rel_display} ---\n{content}\n"
    except Exception as e:
        return f"Error reading note: {str(e)}"


def modify_obsidian_note(**kwargs) -> str:
    """The Swiss Army Knife editor for Obsidian Markdown files."""
    vault_path = (kwargs.get("vault_path") or "").strip()
    relative_path = (kwargs.get("relative_path") or "").strip()
    mode = (kwargs.get("mode") or "").strip()
    new_content = kwargs.get("new_content")
    if new_content is None:
        new_content = ""
    target_text = kwargs.get("target_text") or ""

    if not vault_path or not relative_path or not mode:
        return "Error: vault_path, relative_path, and mode are required."

    must_exist = mode not in ("overwrite", "append")
    file_path, err = _resolve_vault_file(
        vault_path,
        relative_path,
        auto_md=True,
        must_exist=must_exist,
    )
    if err or not file_path:
        return err or "Error: Invalid note path."

    rel_display = os.path.relpath(file_path, os.path.realpath(vault_path)).replace("\\", "/")

    # Auto-create missing folders and note file for overwrite/append modes
    created_new = False
    if not os.path.exists(file_path) and mode in ("overwrite", "append"):
        parent_dir = os.path.dirname(file_path)
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("")
        created_new = True

    if not os.path.isfile(file_path):
        return f"Error: Note not found at {rel_display}. Cannot use '{mode}' mode on a non-existent file."

    try:
        print(f"\n📝 [OBSIDIAN] Editing note ({mode}): {rel_display}...")
        if mode == "overwrite":
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            verb = "Created and wrote" if created_new else "Overwrote"
            return f"Success: {verb} '{rel_display}'."

        elif mode == "append":
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                existing = f.read()
            separator = "" if not existing.strip() else "\n\n"
            with open(file_path, "a", encoding="utf-8") as f:
                f.write(separator + new_content)
            verb = "Created and wrote" if created_new else "Appended text to the bottom of"
            return f"Success: {verb} '{rel_display}'."

        elif mode in ("insert_after_text", "replace_text"):
            if not target_text:
                return f"Error: target_text is required for mode '{mode}'."

            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()

            if target_text not in content:
                return (
                    f"Error: The target_text was not found exactly as provided in '{rel_display}'. "
                    "Please read the file first with read_obsidian_note to copy the exact string."
                )

            if mode == "insert_after_text":
                content = content.replace(target_text, target_text + "\n\n" + new_content, 1)
                msg = f"Success: Inserted new text directly below the target text in '{rel_display}'."
            else:
                content = content.replace(target_text, new_content, 1)
                msg = f"Success: Replaced the target text with new text in '{rel_display}'."

            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)

            return msg

        else:
            return f"Error: Unknown mode '{mode}'. Use overwrite, append, insert_after_text, or replace_text."

    except Exception as e:
        return f"Error modifying note: {str(e)}"


def open_obsidian_note(**kwargs) -> str:
    """Deep-links directly into the Obsidian native app, opening the specific note."""
    vault_path = (kwargs.get("vault_path") or "").strip()
    relative_path = (kwargs.get("relative_path") or "").strip()

    file_path, err = _resolve_vault_file(vault_path, relative_path, auto_md=True, must_exist=True)
    if err or not file_path:
        return err or "Error: Invalid note path."

    try:
        abs_path = file_path.replace("\\", "/")
        encoded_path = urllib.parse.quote(abs_path, safe="")
        uri = f"obsidian://open?path={encoded_path}"

        rel_display = os.path.relpath(file_path, os.path.realpath(vault_path)).replace("\\", "/")
        print(f"\n🖥️ [OBSIDIAN] Launching Native App via URI for '{rel_display}'...")
        os.startfile(uri)

        return f"Success: Triggered Obsidian to open '{rel_display}' on the screen."

    except Exception as e:
        return f"System Error trying to launch Obsidian deep link: {str(e)}"


def map_obsidian_graph(**kwargs) -> str:
    """
    Scans the entire Obsidian vault and maps out the relational network of [[wikilinks]].
    Returns a JSON adjacency map showing how files connect to each other.
    """
    vault_path = (kwargs.get("vault_path") or "").strip()
    if not vault_path or not os.path.isdir(vault_path):
        return f"Error: The vault path '{vault_path}' does not exist or is invalid."

    vault_real = os.path.realpath(vault_path)
    print(f"\n🕸️ [OBSIDIAN] Generating relational graph map for: {vault_real}...")
    graph_map = {}

    try:
        for root, dirs, files in os.walk(vault_real):
            dirs[:] = sorted(d for d in dirs if d not in _IGNORE_DIRS)
            rel_root = os.path.relpath(root, vault_real)
            if rel_root == ".":
                rel_root = ""

            for f in sorted(files):
                if not f.lower().endswith(".md"):
                    continue
                file_path = os.path.join(root, f)
                rel_path = os.path.join(rel_root, f).replace("\\", "/")

                try:
                    with open(file_path, "r", encoding="utf-8", errors="ignore") as md_file:
                        content = md_file.read()

                    raw_links = _WIKILINK_PATTERN.findall(content)
                    clean_links = []
                    for link in raw_links:
                        clean_link = link.split("|")[0].split("#")[0].strip()
                        if clean_link and clean_link not in clean_links:
                            clean_links.append(clean_link)

                    if clean_links:
                        graph_map[rel_path] = clean_links

                except Exception as read_err:
                    print(f"⚠️ [OBSIDIAN] Failed to parse links in {f}: {read_err}")

        if not graph_map:
            return "The vault contains no internal [[wikilinks]]. It is a flat file structure."

        final_output = "--- OBSIDIAN RELATIONAL GRAPH MAP ---\n"
        final_output += json.dumps(graph_map, indent=2)
        final_output += (
            "\n\nSYSTEM NOTE: The keys are the source files, and the arrays contain the names "
            "of the notes they link to. Use this map to navigate topics autonomously without "
            "needing to read every file."
        )
        return final_output

    except Exception as e:
        return f"Error mapping Obsidian graph: {str(e)}"


# ---------------------------------------------------------------------------
# Tool Dispatch Map
# ---------------------------------------------------------------------------

OBSIDIAN_TOOLS = {
    "get_obsidian_vaults": get_obsidian_vaults,
    "scan_obsidian_vault": scan_obsidian_vault,
    "search_obsidian_notes": search_obsidian_notes,
    "read_obsidian_note": read_obsidian_note,
    "modify_obsidian_note": modify_obsidian_note,
    "open_obsidian_note": open_obsidian_note,
    "map_obsidian_graph": map_obsidian_graph,
}


# ---------------------------------------------------------------------------
# OpenAI Responses API Tool Schemas (Flat Function Format)
# ---------------------------------------------------------------------------

OBSIDIAN_TOOLS_SCHEMA = [
    {
        "type": "function",
        "name": "get_obsidian_vaults",
        "description": (
            "Instantly discovers all local Obsidian vaults on the user's PC from Obsidian's "
            "AppData config and returns their absolute paths. Call this first when you don't "
            "already know the user's vault_path."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "type": "function",
        "name": "scan_obsidian_vault",
        "description": (
            "Scans a local Obsidian vault (or an optional subfolder) and returns a complete index "
            "of folders ([DIR]) and Markdown (.md) notes ([FILE]) inside it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "vault_path": {
                    "type": "string",
                    "description": "The absolute path to the Obsidian vault directory on disk.",
                },
                "subfolder": {
                    "type": "string",
                    "description": "Optional relative subfolder inside the vault to scope the scan.",
                },
            },
            "required": ["vault_path"],
        },
    },
    {
        "type": "function",
        "name": "search_obsidian_notes",
        "description": (
            "Performs a fast case-insensitive search across all Markdown filenames and note "
            "contents inside an Obsidian vault, returning matching relative paths and line snippets."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "vault_path": {
                    "type": "string",
                    "description": "The absolute path to the Obsidian vault directory.",
                },
                "query": {
                    "type": "string",
                    "description": "Keyword or phrase to search for in note titles and bodies.",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of matching notes to return (default 10, max 25).",
                },
            },
            "required": ["vault_path", "query"],
        },
    },
    {
        "type": "function",
        "name": "read_obsidian_note",
        "description": "Reads the full raw Markdown content of a specific Obsidian note.",
        "parameters": {
            "type": "object",
            "properties": {
                "vault_path": {
                    "type": "string",
                    "description": "Absolute path to the Obsidian vault.",
                },
                "relative_path": {
                    "type": "string",
                    "description": "Relative path to the note inside the vault (e.g. 'Projects/Roadmap.md').",
                },
            },
            "required": ["vault_path", "relative_path"],
        },
    },
    {
        "type": "function",
        "name": "modify_obsidian_note",
        "description": (
            "Creates or edits an Obsidian Markdown note. Supports 'overwrite' (creates file/folders "
            "if missing), 'append' (adds to the end, creating if missing), 'insert_after_text', "
            "and 'replace_text'. Always read the note first before using insert_after_text or replace_text."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "vault_path": {
                    "type": "string",
                    "description": "Absolute path to the Obsidian vault.",
                },
                "relative_path": {
                    "type": "string",
                    "description": "Relative path to the note inside the vault (e.g. 'Daily/2026-11-26.md').",
                },
                "mode": {
                    "type": "string",
                    "enum": ["overwrite", "append", "insert_after_text", "replace_text"],
                    "description": "Editing mode to apply to the note.",
                },
                "new_content": {
                    "type": "string",
                    "description": "The Markdown text to write, append, insert, or substitute.",
                },
                "target_text": {
                    "type": "string",
                    "description": (
                        "Exact existing text snippet to anchor against. Required for "
                        "'insert_after_text' and 'replace_text' modes."
                    ),
                },
            },
            "required": ["vault_path", "relative_path", "mode", "new_content"],
        },
    },
    {
        "type": "function",
        "name": "open_obsidian_note",
        "description": "Deep-links directly into the native Obsidian desktop app and opens the specified note on screen.",
        "parameters": {
            "type": "object",
            "properties": {
                "vault_path": {
                    "type": "string",
                    "description": "Absolute path to the Obsidian vault.",
                },
                "relative_path": {
                    "type": "string",
                    "description": "Relative path to the note inside the vault.",
                },
            },
            "required": ["vault_path", "relative_path"],
        },
    },
    {
        "type": "function",
        "name": "map_obsidian_graph",
        "description": (
            "Analyzes an Obsidian vault and returns a JSON relational adjacency map of how notes "
            "connect via [[wikilinks]]. Use this to explore connected topics across the vault."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "vault_path": {
                    "type": "string",
                    "description": "Absolute path to the Obsidian vault.",
                },
            },
            "required": ["vault_path"],
        },
    },
]
