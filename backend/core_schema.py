"""
Core OpenAI tool schemas loaded directly into RAM.
Replaces tool_registry.json to eliminate disk reads and PyInstaller pathing traps.
"""

CORE_TOOLS_SCHEMA = [
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
            "name": "look_at_screen",
            "description": "Takes a visual screenshot of the user's screen or a specific window so you can see and analyze UI, code, errors, images, or layout. Temporarily hides AIDEN's overlay cleanly before capture. Check FOCUS and OPEN_WINDOWS in [CURRENT CONSCIOUSNESS STATE] first so you can target a window directly without calling get_active_windows.",
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["whole_screen", "active_window", "window"],
                        "description": "'whole_screen' for the entire active monitor, 'active_window' to crop tightly to the currently focused window, or 'window' to crop a specific window named in window_name.",
                    },
                    "window_name": {
                        "type": "string",
                        "description": "Required only when scope is 'window': app or title substring from FOCUS or OPEN_WINDOWS (e.g., 'chrome', 'code', 'PowerShell', 'Spotify').",
                    },
                    "detail": {
                        "type": "string",
                        "enum": ["low", "high"],
                        "description": "'high' (default) when reading text, code, errors, or UI details; 'low' for fast coarse overview without small text.",
                    },
                },
                "required": ["scope", "detail"],
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
            "name": "media_play",
            "description": "Resumes or starts playback on the currently active media player (Spotify, YouTube, browser, etc.).",
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
            "name": "media_pause",
            "description": "Pauses playback on the currently active media player (Spotify, YouTube, browser, etc.).",
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
            "name": "media_next_track",
            "description": "Skips to the next track in the currently active music or media playlist.",
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
            "name": "media_previous_track",
            "description": "Navigates back to the previous track in the playlist (jumps to the prior song, not just restarting the current one).",
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
            "name": "media_restart_track",
            "description": "Restarts the currently playing track from the beginning (0:00).",
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
            "description": "Connects to an external service integration (e.g. 'gmail', 'spotify', 'google_calendar', 'antigravity_work', 'notes_vault') and mounts its specialized tools into your toolset. Call this ONLY IF the service's tools are not already mounted in your toolset or listed under [ACTIVE CONNECTORS].",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {
                        "type": "string",
                        "enum": [
                            "gmail",
                            "spotify",
                            "google_calendar",
                            "antigravity_work",
                            "notes_vault",
                            "youtube_visual",
                            "file_system",
                        ],
                        "description": "External service connector to mount (e.g. 'gmail', 'antigravity_work').",
                    },
                },
                "required": ["service_name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "render_a2ui_surface",
            "description": (
                "Renders a rich interactive Liquid-Glass A2UI v0.9 card inside AIDEN's 466px pill using the "
                "trusted `aiden.glass.v1` component catalog. Use this generously whenever interactive widgets, "
                "live reactive calculators/converters (with sliders & computed formulas), checklists with progress, "
                "tabbed comparisons, quick mini-forms, quizzes/flashcards, editable action confirmations, or "
                "visual PC/data snapshots give a better experience than plain text. NEVER use it to duplicate "
                "existing dedicated cards (Weather, Gmail inbox, Calendar, Spotify, Location, Volume/Brightness, "
                "or live Antigravity execution progress)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "components": {
                        "type": "array",
                        "description": (
                            "Flat adjacency list of UI nodes (<= 40 nodes, root id='root'). Allowed `component` values: "
                            "Card, Column, Row (max 2-3 compact items), Text (props: text, variant='title'|'subtitle'|'body'|'caption'|'mono'), "
                            "Badge (props: text, tone='emerald'|'amber'|'rose'|'sky'), Divider, "
                            "Button (props: label, variant='primary'|'emerald'|'danger'|'ghost', actionId, disableWhen, lockOnClick, resolvedLabel, resolvedTone, clientPrefill, copyText), "
                            "TextField (props: label, bind, placeholder, multiline, disableWhen), "
                            "CheckBox (props: label, bind, strikeOnCheck, disableWhen), "
                            "ChoiceChips (props: label, options[], bind, actionId, disableWhen), "
                            "Slider (props: label, min, max, step, unit, prefix, bind, disableWhen), "
                            "Tabs (props: bind, tabs=[{id, label, childId}]), "
                            "Metric (props: label, value, sub), "
                            "Progress (props: label, value, tone), "
                            "ListItem (props: left, right, tone). "
                            "Dynamic text/value/tone props can bind to data_model via `{\"path\": \"/key\"}` or `\"{{/key}}\"`."
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "component": {
                                    "type": "string",
                                    "enum": [
                                        "Card", "Column", "Row", "Text", "Badge", "Divider",
                                        "Button", "TextField", "CheckBox", "ChoiceChips",
                                        "Slider", "Tabs", "Metric", "Progress", "ListItem",
                                    ],
                                },
                                "props": {"type": "object"},
                                "children": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                            },
                            "required": ["id", "component"],
                        },
                    },
                    "data_model": {
                        "type": "object",
                        "description": "Initial reactive JSON state bound by sliders, text fields, checkboxes, tabs, chips, and metrics (e.g. {'bill': 120, 'tip': 18, 'people': '4'}).",
                    },
                    "computed": {
                        "type": "object",
                        "description": (
                            "Optional safe local reactive formulas recomputed at 60fps in React whenever data_model changes. "
                            "Map output key -> {expr, prefix?, suffix?, decimals?}. "
                            "Supports +, -, *, /, (), round(x,d), floor, ceil, abs, min, max, pow, clamp, countTrue('prefix'), pctTrue('prefix'). "
                            "Example: {'perPerson': {'expr': '(bill * (1 + tip / 100)) / people', 'prefix': '$', 'decimals': 2}}."
                        ),
                    },
                    "surface_id": {
                        "type": "string",
                        "description": "Optional short unique surface identifier (e.g. 's_split_calc').",
                    },
                    "root_id": {
                        "type": "string",
                        "description": "Root component ID (defaults to 'root').",
                    },
                },
                "required": ["components"],
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
