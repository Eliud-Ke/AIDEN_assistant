"""
Core OpenAI tool schemas loaded directly into RAM.
Replaces tool_registry.json to eliminate disk reads and PyInstaller pathing traps.
"""

CORE_TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "get_system_telemetry",
            "description": "Get the current CPU, RAM, and Battery usage of the host machine. Use this when the user asks about system health, computer performance, or battery life.",
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
            "description": "Get the exact current local time and date. Use this whenever the user asks for the time, date, or day of the week.",
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
            "description": "Reads OS-level GPS coordinates and reverse-geocodes them into a readable address (City, County, Country). Use this to get the user's current physical location.",
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
            "description": "Fetches live weather, a 24-hour timeline, and a multi-day forecast for any city or detected location.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The target city name (e.g., 'Kisumu', 'Nairobi', 'London').",
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
            "description": "Opens a specific web URL directly in the user's default browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The full HTTPS URL to navigate to.",
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
            "description": "Launches an installed desktop application, Store app, or registered program on the user's PC.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app_name": {
                        "type": "string",
                        "description": "The exact or common name/alias of the program to open.",
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
            "description": "Terminates a specific application process running on the host PC.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app_process_name": {
                        "type": "string",
                        "description": "The process executable name ending in .exe (e.g., 'msedge.exe').",
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
            "description": "Returns a list of all currently visible open desktop windows, titles, and active background process names.",
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
            "description": "Adjusts master system audio level as an absolute percentage (0-100) or relative offset (+10, -10).",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": {
                        "type": "string",
                        "description": "The target volume level string (e.g., '50', '+10', '0').",
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
            "description": "Adjusts Windows display brightness as an absolute level (0-100) or relative offset (+15, -15).",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": {
                        "type": "string",
                        "description": "The target brightness level string (e.g., '60', '+20', 'dim').",
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
            "description": "Executes hardware power state transitions: lock screen, shutdown, restart, hibernate, or aborting scheduled shutdowns.",
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
                        "description": "The specific power operation to run.",
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
            "description": "Navigates directly to a designated Windows Settings sub-page or Windows Security panel.",
            "parameters": {
                "type": "object",
                "properties": {
                    "setting_name": {
                        "type": "string",
                        "description": "Target settings URI shortcut (e.g., 'wifi', 'bluetooth', 'display', 'windows update').",
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
            "description": "Polls the Windows system Global System Media Transport Controls to detect what track, video, or stream is playing across any native player or browser.",
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
            "description": "Dispatches OS-level media keystroke events (play, pause, stop, next, previous) across active media apps.",
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
                        "description": "The playback transport action.",
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
            "description": "Queries item count and storage size of the Windows Recycle Bin or permanently purges its contents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["check", "empty"],
                        "description": "Specify 'check' to inspect storage consumed or 'empty' to clear it.",
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
            "description": "Fetches Scripture passages or verses using a standard Bible reference (e.g., 'John 3:16', 'Psalm 23', 'Romans 8:28-30'). Supports optional translation selection.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {
                        "type": "string",
                        "description": "The Bible reference to look up (e.g., 'John 3:16-18', 'Genesis 1:1', 'Psalm 23').",
                    },
                    "translation": {
                        "type": "string",
                        "enum": ["web", "kjv", "asv", "bbe"],
                        "description": "Optional translation. Default is 'web' (World English Bible). 'kjv' is King James Version.",
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
            "description": "Reads the local registry to see what apps are installed. STRICT RULE: ONLY trigger this tool if the user explicitly asks a question like 'what apps do I have?', 'what games are installed?', 'list my apps' or when launch_app tool fails and u need to confirm if the app is actually installed. NEVER use this tool to verify an app before launching it. If the user says 'Open [App]', immediately use the launch_app tool without checking this list first.",
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
            "name": "fetch_explanatory_media",
            "description": "Retrieves a set of exactly 4 rich, high-resolution explanatory visual images to illustrate an explanation. MANDATORY RULE: You MUST call this tool whenever answering questions that involve explanations, concepts, history, landmarks, places, science, technology, famous figures, animals, or any topic benefiting from visual illustration. Each tool call returns exactly 4 images for a single horizontal row. If your explanation covers multiple distinct eras or topics, call this tool multiple times (once for each section). In your response text, insert each 4-image row at the exact contextually relevant position (at the beginning before text, between paragraphs, or at the end) using this exact markdown tag: ::media-gallery[image_url_1 | Caption 1, image_url_2 | Caption 2, image_url_3 | Caption 3, image_url_4 | Caption 4]::",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The specific subject to find 4 explanatory photos/diagrams for in this row (e.g. 'French Revolution storming of the Bastille', 'Palace of Versailles Hall of Mirrors', 'James Webb Space Telescope optics', 'Ferrari F40').",
                    },
                    "additional_queries": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of additional specific sub-queries to fetch a diverse set of images (e.g. ['Palace of Versailles', 'Napoleon Bonaparte']).",
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of images to fetch (always defaults to 4).",
                    },
                },
                "required": ["query"],
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
