# =========================================================
# THE MASTER TOOL REGISTRY
# =========================================================

import tools_system
import tools_gmail
import tools_calendar
import connectors

AVAILABLE_TOOLS = {
    **tools_system.SYSTEM_TOOLS,
    **tools_gmail.GMAIL_TOOLS,
    **tools_calendar.CALENDAR_TOOLS,
    "connect_service": connectors.connect_service,
}
