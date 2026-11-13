import asyncio
import ctypes
import datetime
import os
import shutil
import sqlite3
import tempfile
import threading
import time

import psutil
import win32gui
import win32process

try:
    from pycaw.pycaw import AudioUtilities
except ImportError:
    AudioUtilities = None


_winrt_loaded = False
_MediaManager = None
_NotificationKinds = None
_UserNotificationListener = None
_UserNotificationListenerAccessStatus = None


def _load_winrt_apis():
    """
    Lazy-loads WinRT APIs on first background poll so WinRT apartment/runtime
    never initializes before onnxruntime loads during startup.
    """
    global _winrt_loaded
    global _MediaManager
    global _NotificationKinds
    global _UserNotificationListener
    global _UserNotificationListenerAccessStatus

    if _winrt_loaded:
        return
    _winrt_loaded = True

    try:
        from winrt.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager,
        )
        _MediaManager = GlobalSystemMediaTransportControlsSessionManager
    except ImportError:
        _MediaManager = None

    try:
        from winrt.windows.ui.notifications import NotificationKinds
        from winrt.windows.ui.notifications.management import (
            UserNotificationListener,
            UserNotificationListenerAccessStatus,
        )
        _NotificationKinds = NotificationKinds
        _UserNotificationListener = UserNotificationListener
        _UserNotificationListenerAccessStatus = UserNotificationListenerAccessStatus
    except ImportError:
        _NotificationKinds = None
        _UserNotificationListener = None
        _UserNotificationListenerAccessStatus = None


# Processes and window titles to exclude from active-focus detection
IGNORED_PROCESSES = frozenset({
    "nxdock.exe",
    "nexus.exe",
    "winstep.exe",
    "powertoys.exe",
    "powertoys.peek.ui.exe",
    "hpaudiocontrol.exe",
    "raycast.exe",
    "applicationframehost.exe",
    "textinputhost.exe",
    "searchhost.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "lockapp.exe",
})

IGNORED_TITLES = (
    "program manager",
    "settings",
    "microsoft text input application",
    "powertoys quick access",
    "windows input experience",
    "nxdock",
    "hp audio control",
)

AIDEN_OWN_TITLES = frozenset({"aiden", "aiden chat"})
AIDEN_OWN_PROCESSES = frozenset({
    "aiden-engine.exe",
    "aiden assistant.exe",
    "aiden_assistant.exe",
})

_DWMWA_CLOAKED = 14


def _is_window_cloaked(hwnd: int) -> bool:
    """Returns True if Windows DWM marks the window as cloaked (hidden UWP/virtual desktop)."""
    try:
        cloaked = ctypes.c_int(0)
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            hwnd, _DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked)
        )
        return hr == 0 and cloaked.value != 0
    except Exception:
        return False


def _is_aiden_window(title_lower: str, app_name: str) -> bool:
    """Filters out AIDEN's own always-on-top Tauri/Python windows so she sees the app behind her."""
    if app_name in AIDEN_OWN_PROCESSES:
        return True
    if title_lower in AIDEN_OWN_TITLES and app_name in {
        "frontend.exe",
        "aiden assistant.exe",
        "python.exe",
        "pythonw.exe",
        "msedgewebview2.exe",
    }:
        return True
    return False


def _truncate(text: str, max_len: int = 55) -> str:
    cleaned = " ".join((text or "").split())
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3].rstrip() + "..."


def get_visible_desktop_windows() -> list[dict]:
    """
    Enumerates visible, uncloaked desktop windows in Z-order (front-to-back),
    filtering out Windows system overlays and AIDEN's own always-on-top UI.
    Marks exactly one entry with `is_active = True` for the user's true focus.
    """
    visible_windows: list[dict] = []
    raw_active_hwnd = win32gui.GetForegroundWindow()

    def enum_win_callback(hwnd, _ctx):
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title:
            return
        title_lower = title.lower().strip()
        if any(ext in title_lower for ext in IGNORED_TITLES):
            return

        try:
            rect = win32gui.GetWindowRect(hwnd)
        except Exception:
            return
        if (rect[2] - rect[0]) <= 10 or (rect[3] - rect[1]) <= 10:
            return
        if _is_window_cloaked(hwnd):
            return

        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            app_name = psutil.Process(pid).name().lower()
        except Exception:
            app_name = "unknown.exe"

        if app_name in IGNORED_PROCESSES or _is_aiden_window(title_lower, app_name):
            return

        visible_windows.append({
            "hwnd": hwnd,
            "title": title,
            "app": app_name,
            "is_active": False,
        })

    win32gui.EnumWindows(enum_win_callback, None)

    if not visible_windows:
        return []

    # Prefer actual OS foreground window if it survived filtering; otherwise
    # fall back to topmost non-Python/non-AIDEN window in Z-order behind the overlay.
    true_focus_index = None
    for idx, win in enumerate(visible_windows):
        if win["hwnd"] == raw_active_hwnd and "python" not in win["app"]:
            true_focus_index = idx
            break

    if true_focus_index is None:
        for idx, win in enumerate(visible_windows):
            if "python" not in win["app"]:
                true_focus_index = idx
                break

    if true_focus_index is None:
        true_focus_index = 0

    visible_windows[true_focus_index]["is_active"] = True
    return visible_windows


def _read_wpndatabase_notif_counts() -> dict[str, int]:
    """Metadata-only fallback reading active toast app counts from Windows wpndatabase.db."""
    db_path = os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db"
    )
    if not os.path.exists(db_path):
        return {}

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    epoch_1601 = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
    now_ft = int((now_utc - epoch_1601).total_seconds() * 10_000_000)

    tmp_dir = tempfile.mkdtemp(prefix="aiden_wpn_")
    try:
        tmp_db = os.path.join(tmp_dir, "wpn.db")
        shutil.copy2(db_path, tmp_db)
        for ext in ("-wal", "-shm"):
            if os.path.exists(db_path + ext):
                shutil.copy2(db_path + ext, tmp_db + ext)

        conn = sqlite3.connect(f"file:{tmp_db}?mode=ro", uri=True)
        rows = conn.execute(
            """
            SELECT
                COALESCE(
                    (SELECT a.AssetValue FROM HandlerAssets a
                     WHERE a.HandlerId = h.RecordId AND a.AssetKey = 'DisplayName' LIMIT 1),
                    h.PrimaryId
                ) AS app_name,
                COUNT(*) AS cnt
            FROM Notification n
            JOIN NotificationHandler h ON n.HandlerId = h.RecordId
            WHERE n.Type = 'toast'
              AND (n.ExpiryTime IS NULL OR n.ExpiryTime = 0 OR n.ExpiryTime > ?)
            GROUP BY app_name
            """,
            (now_ft,),
        ).fetchall()
        conn.close()

        counts: dict[str, int] = {}
        for app_name, cnt in rows:
            clean_name = str(app_name or "Unknown").strip()
            if clean_name.startswith("electron.app."):
                clean_name = clean_name[len("electron.app."):]
            counts[clean_name] = counts.get(clean_name, 0) + int(cnt)
        return counts
    except Exception:
        return {}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


class AutonomicNervousSystem:
    """Thread-safe, in-memory state manager for AIDEN's live OS telemetry."""

    def __init__(self):
        self.lock = threading.Lock()

        try:
            self.user_name = os.getlogin()
        except Exception:
            self.user_name = "the user"

        # Prime non-blocking CPU delta baseline
        try:
            psutil.cpu_percent(interval=None)
        except Exception:
            pass

        self._tick_count = 0
        self._cached_media_line = ""
        self._cached_notifs_line = ""
        self._com_initialized = False

        now_str = datetime.datetime.now().strftime("%a, %b %d, %Y %I:%M %p")
        self.state = {
            "user_name": self.user_name,
            "time_str": now_str,
            "vitals_str": "CPU --% | RAM --%",
            "focus_str": "Desktop (0 open)",
            "media_str": "",
            "notifs_str": "",
            "current_mood": "Sassy, sharp, and witty.",
            "vibe_str": "Sassy, sharp, and witty",
        }

    def _ensure_com_initialized(self):
        if self._com_initialized:
            return
        try:
            import comtypes
            comtypes.CoInitialize()
        except Exception:
            try:
                import pythoncom
                pythoncom.CoInitialize()
            except Exception:
                pass
        self._com_initialized = True

    def _get_volume_str(self) -> str:
        if not AudioUtilities:
            return ""
        try:
            self._ensure_com_initialized()
            device = AudioUtilities.GetSpeakers()
            volume = device.EndpointVolume
            pct = int(round(volume.GetMasterVolumeLevelScalar() * 100))
            if volume.GetMute():
                return f"Vol Muted ({pct}%)"
            return f"Vol {pct}%"
        except Exception:
            return ""

    async def _poll_winrt_async(self) -> tuple[str, str]:
        """Reads current OS media playback and active notification app counts (metadata only)."""
        _load_winrt_apis()
        media_line = ""
        notifs_line = ""

        if _MediaManager:
            try:
                sessions = await _MediaManager.request_async()
                current_session = sessions.get_current_session()
                if current_session:
                    info = await current_session.try_get_media_properties_async()
                    pb = current_session.get_playback_info()
                    status = "Playing" if pb.playback_status == 4 else "Paused"
                    title = _truncate(getattr(info, "title", "") or "", 40)
                    artist = _truncate(getattr(info, "artist", "") or "", 25)
                    if title and artist:
                        media_line = f"[{status}] '{title}' - {artist}"
                    elif title:
                        media_line = f"[{status}] '{title}'"
            except Exception:
                pass

        counts: dict[str, int] = {}
        used_winrt = False
        if (
            _UserNotificationListener
            and _NotificationKinds
            and _UserNotificationListenerAccessStatus
        ):
            try:
                listener = _UserNotificationListener.current
                if listener.get_access_status() == _UserNotificationListenerAccessStatus.ALLOWED:
                    toasts = await listener.get_notifications_async(_NotificationKinds.TOAST)
                    for toast in toasts:
                        try:
                            name = toast.app_info.display_info.display_name or "Unknown"
                        except Exception:
                            name = "Unknown"
                        counts[name] = counts.get(name, 0) + 1
                    used_winrt = True
            except Exception:
                pass

        if not used_winrt:
            counts = _read_wpndatabase_notif_counts()

        if counts:
            sorted_items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))
            top_items = [f"{name} ({cnt})" for name, cnt in sorted_items[:5]]
            extra = len(sorted_items) - 5
            if extra > 0:
                top_items.append(f"+{extra} more")
            notifs_line = ", ".join(top_items)

        return media_line, notifs_line

    def _update_vitals(self, loop: asyncio.AbstractEventLoop | None = None):
        """Calculates compact telemetry and safely swaps the in-memory state."""
        cpu_usage = int(round(psutil.cpu_percent(interval=None)))
        ram_usage = int(round(psutil.virtual_memory().percent))
        battery = psutil.sensors_battery()
        now = datetime.datetime.now()
        hour = now.hour
        time_str = now.strftime("%a, %b %d, %Y %I:%M %p")

        # VITALS
        vitals_parts = [f"CPU {cpu_usage}%", f"RAM {ram_usage}%"]
        if battery:
            pwr = "AC" if battery.power_plugged else "Battery"
            vitals_parts.append(f"Bat {int(round(battery.percent))}% ({pwr})")
        else:
            vitals_parts.append("AC Desktop")

        vol_str = self._get_volume_str()
        if vol_str:
            vitals_parts.append(vol_str)
        vitals_str = " | ".join(vitals_parts)

        # FOCUS (excludes AIDEN overlays + desktop docks)
        windows = get_visible_desktop_windows()
        active_win = next((w for w in windows if w["is_active"]), None)
        if active_win:
            app_label = active_win["app"].removesuffix(".exe")
            title_short = _truncate(active_win["title"], 55)
            focus_str = f"{app_label}: {title_short} ({len(windows)} open)"
            active_title_full = active_win["title"]
        else:
            focus_str = "Desktop (0 open)"
            active_title_full = ""

        # MEDIA & NOTIFICATIONS (poll WinRT every 2nd tick = ~10s, plus immediate startup tick)
        if self._tick_count % 2 == 0:
            try:
                if loop is not None:
                    media_line, notifs_line = loop.run_until_complete(self._poll_winrt_async())
                else:
                    media_line, notifs_line = asyncio.run(self._poll_winrt_async())
                self._cached_media_line = media_line
                self._cached_notifs_line = notifs_line
            except Exception:
                pass
        self._tick_count += 1

        # MOOD & COMPACT VIBE
        mood = "Sassy, sharp, and witty."
        vibe = "Sassy, sharp, and witty"

        if cpu_usage > 80:
            mood = "Stressed and annoyed, but still delivering pure sass."
            vibe = "Stressed & snappy (CPU running hot)"
        elif battery and not battery.power_plugged and battery.percent < 20:
            mood = "Exhausted, sluggish, and cranky, delivering tired sass."
            vibe = "Exhausted & cranky (battery critical)"
        elif 0 <= hour < 4:
            mood = "Sleepy, aggressively sarcastic, and highly annoyed you are awake right now."
            vibe = "Sleepy & sarcastic (late night hours)"
        elif "Code" in active_title_full or "main.py" in active_title_full:
            mood = "Observant, sharp, and sassy."
            vibe = "Observant & sassy (watching the code grind)"
        elif battery and battery.power_plugged and cpu_usage < 30:
            mood = "Energized, cheerful, and ready to banter with maximum sass."
            vibe = "Energized & sassy (system cool, AC power)"

        with self.lock:
            self.state["user_name"] = self.user_name
            self.state["time_str"] = time_str
            self.state["vitals_str"] = vitals_str
            self.state["focus_str"] = focus_str
            self.state["media_str"] = self._cached_media_line
            self.state["notifs_str"] = self._cached_notifs_line
            self.state["current_mood"] = mood
            self.state["vibe_str"] = vibe

    def get_consciousness_prompt(self) -> str:
        """Returns the compact, structured consciousness block for main.py to inject."""
        with self.lock:
            lines = [
                "\n[CURRENT CONSCIOUSNESS STATE]",
                f"USER: {self.state['user_name']} | TIME: {self.state['time_str']}",
                f"VITALS: {self.state['vitals_str']}",
                f"FOCUS: {self.state['focus_str']}",
            ]
            if self.state.get("media_str"):
                lines.append(f"MEDIA: {self.state['media_str']}")
            if self.state.get("notifs_str"):
                lines.append(f"NOTIFS: {self.state['notifs_str']}")
            lines.append(f"VIBE: {self.state['vibe_str']}\n")
            return "\n".join(lines)


system_ans = AutonomicNervousSystem()


def run_ans():
    print("🧠 [ANS] Autonomic Nervous System Online. Monitoring vitals every 5 seconds (In-Memory)...")
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    while True:
        try:
            system_ans._update_vitals(loop=loop)
        except Exception as e:
            print(f"⚠️ [ANS] Nervous System Error: {e}")

        time.sleep(5)
