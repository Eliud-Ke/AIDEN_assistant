# =========================================================
# THE MASTER TOOL REGISTRY
# =========================================================

import tools_system
import tools_gmail

AVAILABLE_TOOLS = {
    **tools_system.SYSTEM_TOOLS,
    **tools_gmail.GMAIL_TOOLS,
}
