"""
MCP-Style Dynamic Connector Registry loaded directly into RAM.
AIDEN discovers and mounts connector tool stacks on-demand via `connect_service`
without fragile keyword regex matching.
"""

import tools_gmail
import tools_calendar
import tools_spotify
import tools_antigravity
import tools_obsidian

CONNECTORS_SCHEMA = {
    "gmail": {
        "display_name": "Gmail",
        "description": "Read, search, draft, send, reply, mark as read, and archive emails in the user's Gmail inbox.",
        "tools": tools_gmail.GMAIL_TOOLS_SCHEMA,
    },
    "spotify": {
        "display_name": "Spotify",
        "description": "Search songs, albums, and artists, stream specific tracks, toggle shuffle/repeat, and manage your library.",
        "tools": tools_spotify.SPOTIFY_TOOLS_SCHEMA,
    },
    "google_calendar": {
        "display_name": "Google Calendar",
        "description": "View, schedule, update, and manage calendar events and agenda reminders.",
        "tools": tools_calendar.CALENDAR_TOOLS_SCHEMA,
    },
    "antigravity_work": {
        "display_name": "Antigravity Work",
        "description": "Delegates complex multi-step coding, file system, and PC automation tasks to the local Antigravity CLI agent (Gemini 4 Hydrogen Medium) with a human-in-the-loop plan approval gate and async background Turbo execution.",
        "tools": tools_antigravity.ANTIGRAVITY_TOOLS_SCHEMA,
    },
    "notes_vault": {
        "display_name": "Notes Vault",
        "description": "Discover Obsidian vaults, scan folders, search, read, create, edit, open, and map [[wikilink]] graphs across Markdown notes.",
        "tools": tools_obsidian.OBSIDIAN_TOOLS_SCHEMA,
    },
    "file_system": {
        "display_name": "Local Files",
        "description": "Search and locate local files, folders, and documents on disk.",
        "tools": [],
    },
}

_ALIASES = {
    "gmail_stack": "gmail",
    "mail": "gmail",
    "email": "gmail",
    "spotify_stack": "spotify",
    "google_calendar_stack": "google_calendar",
    "calendar": "google_calendar",
    "notes_vault_stack": "notes_vault",
    "notes": "notes_vault",
    "obsidian": "notes_vault",
    "obsidian_vault": "notes_vault",
    "vault": "notes_vault",
    "file_stack": "file_system",
    "files": "file_system",
    "antigravity": "antigravity_work",
    "antigravity-work": "antigravity_work",
    "antigravity_work_stack": "antigravity_work",
    "agy": "antigravity_work",
    "work": "antigravity_work",
    "work_mode": "antigravity_work",
}


def resolve_connector_key(service_name: str) -> str:
    """Normalizes a service name or alias into its canonical CONNECTORS_SCHEMA key."""
    if not service_name:
        return ""
    clean = service_name.strip().lower()
    return _ALIASES.get(clean, clean)


def connect_service(service_name: str) -> str:
    """
    MCP-style handshake tool: Mounts the requested connector stack and returns
    its available tool schemas/names so the Brain can invoke them immediately.
    """
    key = resolve_connector_key(service_name)
    stack = CONNECTORS_SCHEMA.get(key)

    if not stack:
        available = ", ".join(CONNECTORS_SCHEMA.keys())
        return f"Error: Unknown connector '{service_name}'. Available connectors: {available}."

    display_name = stack.get("display_name", key)
    tools = stack.get("tools", [])
    if not tools:
        return (
            f"Connector '{display_name}' ({key}) is registered, but its tool module is not yet active."
        )

    tool_summaries = []
    for t in tools:
        fn = t.get("function", t)
        t_name = fn.get("name", "")
        t_desc = fn.get("description", "")
        if t_name:
            tool_summaries.append(f"- {t_name}: {t_desc}")

    joined_tools = "\n".join(tool_summaries)
    return (
        f"[CONNECTOR MOUNTED: {display_name.upper()}]\n"
        f"Successfully connected to {display_name}. The following specialized tools are now unlocked and mounted in your toolset:\n"
        f"{joined_tools}\n\n"
        f"Call the appropriate {display_name} tool now to complete the user's request. Do NOT call connect_service('{key}') again because its tools are already active in your toolset."
    )


def get_connector_tool_names() -> list:
    """Extracts all valid tool names dynamically from the RAM connectors schema."""
    names = []
    for stack_data in CONNECTORS_SCHEMA.values():
        for tool in stack_data.get("tools", []):
            fn = tool.get("function", tool)
            if "name" in fn:
                names.append(fn["name"])
    return names
