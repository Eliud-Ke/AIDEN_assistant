"""
Core OpenAI tool schemas loaded directly into RAM.
Replaces tool_registry.json to eliminate disk reads and PyInstaller pathing traps.
"""

CORE_TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "get_system_telemetry",
            "description": "Get current CPU, RAM, and Battery usage of the host PC.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_current_time_date",
            "description": "Get exact current local time, date, and day of the week.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_live_location",
            "description": "Reads OS GPS/Wi-Fi location and returns the human address, coordinates, and accuracy. When answering the user, state ONLY the clean human place name (e.g. 'Kisii, Kenya') by default. Never recite raw latitude, longitude, or accuracy meters unless the user explicitly asks for technical GPS coordinates.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather_forecast",
            "description": "Fetches live weather, 24-hour timeline, and 5-day forecast for any city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "Target city name (e.g., 'Kisumu', 'Nairobi', 'London').",
                    }
                },
                "required": ["location"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_in_browser",
            "description": "Opens a web URL directly in the default browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Full HTTPS URL to open.",
                    }
                },
                "required": ["url"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "launch_app",
            "description": "Launches an installed desktop app, Store app, or program on the PC.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app_name": {
                        "type": "string",
                        "description": "Name or alias of the program to open.",
                    }
                },
                "required": ["app_name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "close_application",
            "description": "Terminates a running application process on the PC.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app_process_name": {
                        "type": "string",
                        "description": "Process executable name ending in .exe (e.g., 'msedge.exe').",
                    }
                },
                "required": ["app_process_name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_active_windows",
            "description": "Returns all visible open desktop windows, titles, and active process names.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_system_volume",
            "description": "Adjusts master system volume as an absolute percentage (0-100) or relative offset (+10, -10).",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": {
                        "type": "string",
                        "description": "Target volume string (e.g., '50', '+10', '0').",
                    }
                },
                "required": ["level"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_system_brightness",
            "description": "Adjusts display brightness as an absolute percentage (0-100) or relative offset (+15, -15).",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": {
                        "type": "string",
                        "description": "Target brightness string (e.g., '60', '+20').",
                    }
                },
                "required": ["level"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_system_power",
            "description": "Executes power state transitions: lock, shutdown, restart, hibernate, or abort.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "lock",
                            "shutdown",
                            "restart",
                            "hibernate",
                            "abort",
                        ],
                        "description": "Power operation to run.",
                    }
                },
                "required": ["action"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_windows_setting",
            "description": "Opens a Windows Settings sub-page or Security panel.",
            "parameters": {
                "type": "object",
                "properties": {
                    "setting_name": {
                        "type": "string",
                        "description": "Target settings shortcut (e.g., 'wifi', 'bluetooth', 'display', 'windows update').",
                    }
                },
                "required": ["setting_name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_currently_playing",
            "description": "Detects the currently playing track or media across system players and browsers.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "control_media_playback",
            "description": "Dispatches OS media playback controls (play, pause, stop, next, previous).",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "enum": [
                            "play",
                            "pause",
                            "stop",
                            "next",
                            "previous",
                        ],
                        "description": "Playback action.",
                    }
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_recycle_bin",
            "description": "Checks item count/size of the Windows Recycle Bin or empties it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["check", "empty"],
                        "description": "'check' to inspect size or 'empty' to clear it.",
                    }
                },
                "required": ["action"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_bible_passage",
            "description": "Fetches Scripture passages by reference (e.g., 'John 3:16', 'Psalm 23').",
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {
                        "type": "string",
                        "description": "Bible reference (e.g., 'John 3:16-18', 'Psalm 23').",
                    },
                    "translation": {
                        "type": "string",
                        "enum": ["web", "kjv", "asv", "bbe"],
                        "description": "Translation (default 'web' or 'kjv').",
                    },
                },
                "required": ["reference"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_installed_apps",
            "description": "Lists installed apps on the PC. ONLY call when the user explicitly asks what apps/games are installed, or if launch_app fails. NEVER call before launch_app.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grounded_web_search",
            "description": "Performs real-time grounded web search for current events, breaking news, live scores/stats, recent developments, or facts post-dating knowledge cutoff. Returns verified facts and source links.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Targeted search query for live facts and sources.",
                    },
                    "search_context": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Search depth: 'low' (default, fast snippet extraction), 'medium', or 'high' (deep research).",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "connect_service",
            "description": "Connects to an external service integration (e.g. 'gmail', 'spotify', 'google_calendar', 'notes_vault') and mounts its specialized tools into your toolset. Call this ONLY IF the service's tools are not already mounted in your toolset or listed under [ACTIVE CONNECTORS].",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {
                        "type": "string",
                        "enum": [
                            "gmail",
                            "spotify",
                            "google_calendar",
                            "notes_vault",
                            "youtube_visual",
                            "file_system",
                        ],
                        "description": "External service connector to mount (e.g. 'gmail').",
                    },
                },
                "required": ["service_name"],
                "additionalProperties": False,
            },
        },
    },
]


def get_core_tool_names() -> list:
    """Extracts all function names declared in the core schema directly in RAM."""
    names = []
    for tool in CORE_TOOLS_SCHEMA:
        fn = tool.get("function", {})
        if "name" in fn:
            names.append(fn["name"])
    return names
