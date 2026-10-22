"""
Dynamic Connector Stacks loaded directly into RAM.
Acts as a lightweight switchboard. Tool schemas will be injected here as they are rebuilt.
"""

CONNECTORS_SCHEMA = {
    "spotify_stack": {
        "keywords": [
            "spotify", "music", "play", "song", "playlist", "track", "album",
            "artist", "listen", "dj", "skip", "pause", "volume", "tunes", "beats"
        ],
        "tools": []  # <-- Schemas go here once rebuilt
    },
    "gmail_stack": {
        "keywords": [
            "email", "gmail", "inbox", "mail", "draft", "send", "message",
            "read", "reply", "forward", "unread", "spam", "receipt", "account key", "compose"
        ],
        "tools": []
    },
    "google_calendar_stack": {
        "keywords": [
            "calendar", "schedule", "meeting", "appointment", "class", "event",
            "book", "cancel", "tomorrow", "reschedule", "agenda", "remind", "reminder", "date", "plan"
        ],
        "tools": []
    },
    "notes_vault_stack": {
        "keywords": [
            "obsidian", "vault", "notes", "markdown", "graph", "notion",
            "workspace", "database", "write", "document", "page", "edit note", "create note", "journal", "diary"
        ],
        "tools": []
    },
    "youtube_visual_stack": {
        "keywords": [
            "youtube", "video", "image", "picture", "show me", "photo",
            "watch", "clip", "visual", "gallery", "thumbnail", "look up", "stream", "visualize", "find picture"
        ],
        "tools": []
    },
    "file_stack": {
        "keywords": [
            "file", "files", "find file", "folder", "directory", "disk",
            "drive", "document search", "storage", "locate", "path", "hard drive", "explorer", "index", "pdf"
        ],
        "tools": []
    }
}


def get_connector_tool_names() -> list:
    """Extracts all valid tool names dynamically from the RAM connectors schema."""
    names = []
    for stack_name, stack_data in CONNECTORS_SCHEMA.items():
        for tool in stack_data.get("tools", []):
            if "function" in tool and "name" in tool["function"]:
                names.append(tool["function"]["name"])
    return names
