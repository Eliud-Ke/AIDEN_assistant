# =========================================================
# THE MASTER TOOL REGISTRY
# =========================================================

import tools_system
import tools_gmail
import tools_calendar
import tools_spotify
import tools_antigravity
import tools_obsidian
import tools_youtube
import tools_a2ui
import connectors

AVAILABLE_TOOLS = {
    **tools_system.SYSTEM_TOOLS,
    **tools_gmail.GMAIL_TOOLS,
    **tools_calendar.CALENDAR_TOOLS,
    **tools_spotify.SPOTIFY_TOOLS,
    **tools_antigravity.ANTIGRAVITY_TOOLS,
    **tools_obsidian.OBSIDIAN_TOOLS,
    **tools_youtube.YOUTUBE_TOOLS,
    **tools_a2ui.A2UI_TOOLS,
    "connect_service": connectors.connect_service,
}
