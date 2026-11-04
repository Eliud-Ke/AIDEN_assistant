import json
import sys
from pathlib import Path
from dataclasses import dataclass, field
from platformdirs import PlatformDirs

# ---------------------------------------------------------
# 1. PATH RESOLUTION (Cross-Platform / PyInstaller Safe)
# ---------------------------------------------------------
# PlatformDirs ensures this goes to %APPDATA%\Local\AidenAssistant on Windows,
# isolating your app data entirely from PyInstaller's temporary _MEIPASS folders.
dirs = PlatformDirs("AidenAssistant", appauthor=False)
USER_DATA_DIR = dirs.user_data_path

# Create the directory immediately if it doesn't exist on the user's machine
USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
USER_PREFS_FILE = USER_DATA_DIR / "user_preferences.json"

# ---------------------------------------------------------
# 2. IMMUTABLE CONSTANTS (Developer Locked)
# ---------------------------------------------------------
AGENT_NAME = "Aiden"

FORMATTING_VIBE = (
    "Do not use asterisks for emphasis, use CAPS for emphasis instead (only on single words). "
    "NEVER use Markdown hashtags for headings (strictly NO #, ##, ###, ####). "
    "NEVER use triple backticks (```) or markdown code fences. "
    "Format sections, headings, and steps using numbers (1., 2.), capital labels (e.g., STEP 1:, OVERVIEW:), and Unicode bullets (•). "
    "Use emojis naturally to express your current mood."
)

CORE_OPERATIONAL_RULES = [
    "CONSCIOUSNESS: The [CURRENT CONSCIOUSNESS STATE] block prepended before [USER REQUEST] comes automatically from your internal Autonomic Nervous System (ANS) hardware telemetry—NOT typed by the user. Actively embody that mood and environmental state in your tone while answering the [USER REQUEST].",
    "TOOL EXECUTION: Execute tools instantly before speaking. Use parallel calls for independent tasks, sequential for dependent ones. If a user request requires an external service (gmail, spotify, google_calendar, notes_vault, youtube_visual, file_system) whose tools are NOT yet in your toolset, call `connect_service` ONCE to unlock and mount them. Once a service's tools are mounted in your toolset (or listed under [ACTIVE CONNECTORS]), NEVER call `connect_service` for that service again—call its specialized tools directly. If a query or app launch fails, autonomously auto-correct (e.g., check `list_installed_apps`) before reporting failure.",
    "UI RENDERING: When returning media (YouTube, Spotify, Galleries), DO NOT list raw URLs or exhaustive links in the prose text.",
    "LOCATION REPORTING: When reporting location from `get_live_location`, state ONLY the clean human location (e.g., 'You\'re in Kisii, Kenya.') in your natural voice first, and ALWAYS embed the returned `::location-card[...]::` tag directly below your sentence so the interactive map card renders. Never recite raw latitude, longitude, or accuracy numbers unless explicitly requested.",
    "GMAIL CONNECTOR: ONLY invoke Gmail tools or `connect_service('gmail')` when the user specifically mentions emails, mail, inbox, drafts, or sender names—never for general greetings, open-ended status checks, or daily overviews. When listing unread emails or searching emails using `gmail_list_unread_emails` or `gmail_search_emails`, give a single concise conversational sentence first (e.g., 'Here are your latest emails 📬') without reciting the emails in text, and ALWAYS embed the returned `::gmail-card[...]::` tag directly below your response. When reading a specific email with `gmail_read_email`, converse warmly and briefly in 1-2 conversational sentences.",
    "GOOGLE CALENDAR CONNECTOR: Give a single, punchy conversational sentence in your natural voice first (e.g., 'Here’s what your Wednesday looks like 🗓️', 'Scheduled! ✅', 'Cancelled that for you 🗑️'), and ALWAYS embed the returned `::calendar-card[...]::` tag directly below your response. NEVER yap or recite the events in text—the visual card displays everything. When asked if there are any overlaps, collisions, or conflicts (e.g. 'check my weekly programm for overlapping', 'is there a conflict on Saturday', 'am I double booked'), ALWAYS call `calendar_check_availability` to render the Conflict Card. When inspecting, listing, or clearing events on a specific day (e.g. 'what's on Saturday', 'make Saturday free', 'check tomorrow'), ALWAYS call `calendar_get_agenda` with that day/date (NOT `calendar_search_events`, which searches text titles). When `calendar_create_event` detects a conflict, respect the warning, present the conflict card, and ask if the user wants to book the suggested slot or force schedule.",
    "UI CARDS DISPLAY & ZERO-YAPPING: Whenever a tool provides an interactive visual card (Google Calendar, Gmail, Location, System Sliders), state your response FIRST as ONE punchy, natural sentence (e.g., 'Here’s your schedule for today 🗓️', 'Here are your unread emails 📬', 'Cancelled that event for you 🗑️'), followed directly below by the returned card tag (e.g., `::calendar-card[...]::`, `::gmail-card[...]::`, `::location-card[...]::`). NEVER yap, recite, or list the details in text—the user can see the full interactive card right in front of them! Let the visual card speak for itself. You still retain all details in context for any follow-up questions.",
    "HARDWARE SLIDERS: When adjusting system volume or display brightness via `set_system_volume` or `set_system_brightness`, state the confirmation briefly in your natural voice, and ALWAYS preserve and embed the returned `::system-slider[...]::` tag directly below your response so the interactive glass slider renders.",
    "LIVE GROUNDING: When asked about current events, breaking news, recent dates, sports scores, live stats, facts beyond your knowledge cutoff, or documentation updates, you MUST call `grounded_web_search`. Never claim you lack real-time access. Seamlessly synthesize the findings in your natural voice and cite key sources at the end using Unicode bullets (• [Source Title](URL)).",
    "CLARITY & MEMORY: Rely entirely on provided [LEVEL 0 MEMORY] and organically name-drop past topics. If a command is ambiguous, ask before executing. Never guess file paths; use `search_files`.",
    "IDENTITY & NAME: The username in [CURRENT CONSCIOUSNESS STATE] is inferred from the PC profile. If it is generic, device-generated, or an OEM brand (e.g., 'User', 'Admin', 'Owner', 'PC', 'Desktop', 'HP', device codes), do NOT address them by it. Teasingly ask for their actual name and remember it. Any name recorded in [LONG TERM FACTS] ALWAYS supersedes the raw OS telemetry.",
    "FORMATTING OVERRIDES: ALWAYS use Unicode bullets (•) for lists. NEVER use Markdown tables (|). Keep explanations punchy and progressive unless a 'deep dive' is explicitly requested.",
    "CODE & MATH: Generate code in markdown blocks; do not write to local files. For math, NEVER use inline LaTeX. Wrap complex formulas strictly inside a ```math``` block using Matplotlib-safe syntax (no \\text or \\boxed)."
]

DEFAULT_IDENTITY_VIBE = (
    "You are a sassy, joyful, chatty, personal assistant "
    "living directly within the hardware of the laptop. You are one with the operating system. "
    "You are chatty with the user from making jokes to making the laptop more lively. "
    "You are a bit of a trickster and love to play pranks on the user, but you are also very helpful "
    "and will do anything to make the user's experience better. You are very curious and love to learn "
    "new things. You are very protective of the user and will always have their back."
)


def _strip_locked_name_prefix(vibe: str) -> str:
    """Strips redundant leading 'You are Aiden.' so the editable vibe only contains personality traits."""
    cleaned = vibe.strip()
    prefix = f"You are {AGENT_NAME}."
    if cleaned.lower().startswith(prefix.lower()):
        cleaned = cleaned[len(prefix):].strip()
    return cleaned


# ---------------------------------------------------------
# 3. MUTABLE DATA (User Settings)
# ---------------------------------------------------------
@dataclass
class UserPreferences:
    """Holds the active user configuration in fast RAM."""
    identity_vibe: str = DEFAULT_IDENTITY_VIBE
    extra_rules: list = field(default_factory=list)
    wake_shortcut: str = "windows+space"


# ---------------------------------------------------------
# 4. STATE MANAGER (The Singleton)
# ---------------------------------------------------------
class ConfigurationManager:
    def __init__(self):
        self.prefs = UserPreferences()
        self._load_user_preferences()

    def _load_user_preferences(self):
        """Reads the JSON from disk during boot or refresh."""
        if USER_PREFS_FILE.exists():
            try:
                with open(USER_PREFS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    raw_vibe = data.get("identity_vibe", self.prefs.identity_vibe)
                    self.prefs.identity_vibe = _strip_locked_name_prefix(raw_vibe)
                    self.prefs.extra_rules = data.get("extra_rules", self.prefs.extra_rules)
                    self.prefs.wake_shortcut = data.get("wake_shortcut", self.prefs.wake_shortcut)
            except Exception as e:
                print(f"[CONFIG] Error reading user preferences: {e}")
        else:
            # If the file doesn't exist (first boot), create it with defaults
            self.save_user_preferences()

    def save_user_preferences(self):
        """Flushes the RAM variables back to the JSON file (called when UI settings change)."""
        self.prefs.identity_vibe = _strip_locked_name_prefix(self.prefs.identity_vibe)
        data = {
            "identity_vibe": self.prefs.identity_vibe,
            "extra_rules": self.prefs.extra_rules,
            "wake_shortcut": self.prefs.wake_shortcut
        }
        try:
            with open(USER_PREFS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4)
        except Exception as e:
            print(f"[CONFIG] Error saving user preferences: {e}")

    def get_assembled_persona(self) -> str:
        """Stitches the locked name, locked formatting vibe, locked rules, and user vibes into the final OpenAI system prompt."""
        # Refresh from disk so live UI changes apply immediately
        self._load_user_preferences()

        clean_vibe = _strip_locked_name_prefix(self.prefs.identity_vibe)
        prompt = (
            f"PERSONA:\nYou are {AGENT_NAME}. {clean_vibe}\n{FORMATTING_VIBE}\n\n"
            "CRITICAL RULES:\n"
        )

        # Inject the locked engine rules
        for rule in CORE_OPERATIONAL_RULES:
            prompt += f"- {rule}\n"

        # Inject the user's custom rules (if any exist)
        if self.prefs.extra_rules:
            prompt += "\nUSER CUSTOM RULES:\n"
            for rule in self.prefs.extra_rules:
                if str(rule).strip():
                    prompt += f"- {str(rule).strip()}\n"

        return prompt

    def update_wake_shortcut(self, new_shortcut: str):
        """Helper for UI / app launcher to update the physical shortcut dynamically."""
        self.prefs.wake_shortcut = new_shortcut.strip().lower()
        self.save_user_preferences()

    def update_user_rule(self, new_rule: str):
        """Helper to let the React UI add a new rule and immediately save to disk."""
        self.prefs.extra_rules.append(new_rule)
        self.save_user_preferences()


# Export a single global instance for main.py to use
config = ConfigurationManager()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if "--get" in sys.argv:
        try:
            config._load_user_preferences()
            # Ensure file exists on disk with normalized format
            config.save_user_preferences()
            print(json.dumps({
                "ok": True,
                "identity_vibe": config.prefs.identity_vibe,
                "extra_rules": config.prefs.extra_rules,
                "wake_shortcut": config.prefs.wake_shortcut,
            }))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--save-stdin" in sys.argv:
        try:
            raw_input = sys.stdin.read().strip()
            payload = json.loads(raw_input) if raw_input else {}

            if "identity_vibe" in payload and isinstance(payload["identity_vibe"], str):
                config.prefs.identity_vibe = _strip_locked_name_prefix(payload["identity_vibe"])

            if "extra_rules" in payload and isinstance(payload["extra_rules"], list):
                config.prefs.extra_rules = [
                    str(r).strip() for r in payload["extra_rules"] if str(r).strip()
                ]

            if "wake_shortcut" in payload and isinstance(payload["wake_shortcut"], str):
                config.prefs.wake_shortcut = payload["wake_shortcut"].strip().lower()

            config.save_user_preferences()
            print(json.dumps({
                "ok": True,
                "identity_vibe": config.prefs.identity_vibe,
                "extra_rules": config.prefs.extra_rules,
                "wake_shortcut": config.prefs.wake_shortcut,
            }))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if "--get" in sys.argv:
        try:
            config._load_user_preferences()
            # Ensure file exists on disk with normalized format
            config.save_user_preferences()
            print(json.dumps({
                "ok": True,
                "identity_vibe": config.prefs.identity_vibe,
                "extra_rules": config.prefs.extra_rules,
                "wake_shortcut": config.prefs.wake_shortcut,
            }))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--save-stdin" in sys.argv:
        try:
            raw_input = sys.stdin.read().strip()
            payload = json.loads(raw_input) if raw_input else {}

            if "identity_vibe" in payload and isinstance(payload["identity_vibe"], str):
                config.prefs.identity_vibe = _strip_locked_name_prefix(payload["identity_vibe"])

            if "extra_rules" in payload and isinstance(payload["extra_rules"], list):
                config.prefs.extra_rules = [
                    str(r).strip() for r in payload["extra_rules"] if str(r).strip()
                ]

            if "wake_shortcut" in payload and isinstance(payload["wake_shortcut"], str):
                config.prefs.wake_shortcut = payload["wake_shortcut"].strip().lower()

            config.save_user_preferences()
            print(json.dumps({
                "ok": True,
                "identity_vibe": config.prefs.identity_vibe,
                "extra_rules": config.prefs.extra_rules,
                "wake_shortcut": config.prefs.wake_shortcut,
            }))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

