"""
Dynamic Physical Shortcut Detector for AIDEN.
Supports global hotkeys (default: Windows + Space) to toggle AIDEN between
Sleep Mode and Awake Mode. Allows runtime customization for the UI app launcher.
"""

import sys
import time
import threading
import ctypes
from typing import Callable, Optional

# Ensure Windows stdout handles UTF-8 cleanly
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

try:
    import keyboard
except ImportError:
    keyboard = None

from configuration import config

# Windows API for suppressing Start Menu when Win key is pressed alone
user32 = ctypes.windll.user32 if hasattr(ctypes, 'windll') else None


def _suppress_start_menu():
    """Sends unassigned dummy virtual key 0xE8 to cancel Windows Start Menu popup."""
    if user32:
        try:
            # 0xE8 is unassigned in Windows; sending it signals that Win was part of a combination
            user32.keybd_event(0xE8, 0, 0, 0)
            user32.keybd_event(0xE8, 0, 2, 0)
        except Exception:
            pass


WIN_KEY_NAMES = {"windows", "win", "left windows", "right windows"}
WIN_SCAN_CODES = {91, 92, 57435, 57436}


class ShortcutDetector:
    """Manages dynamic system-wide physical shortcut detection."""

    def __init__(self,
                 shortcut_wake_event: threading.Event,
                 shortcut_sleep_event: threading.Event,
                 on_toggle_callback: Optional[Callable[[str], None]] = None):
        self.shortcut_wake_event = shortcut_wake_event
        self.shortcut_sleep_event = shortcut_sleep_event
        self.on_toggle_callback = on_toggle_callback

        self._lock = threading.Lock()
        self._current_state = "sleeping"  # "sleeping" or "awake"
        self._active_hotkey_hook = None
        self._active_key_hook = None
        self._current_shortcut = config.prefs.wake_shortcut or "windows+space"
        self._last_trigger_time = 0.0

        # Standalone Win key tracking
        self._win_down = False
        self._win_down_time = 0.0
        self._other_key_pressed = False

    def set_state(self, new_state: str):
        """Updates internal state tracker ('sleeping' or 'awake')."""
        with self._lock:
            self._current_state = new_state.lower().strip()

    def get_state(self) -> str:
        """Returns the current state."""
        with self._lock:
            return self._current_state

    def _handle_hotkey_press(self):
        """Executed whenever the physical shortcut is detected."""
        now = time.time()
        with self._lock:
            # Debounce cooldown: ignore triggers within 0.6 seconds
            if now - self._last_trigger_time < 0.6:
                return
            self._last_trigger_time = now
            state = self._current_state

        if state == "sleeping":
            print(
                f"\n⚡ [SHORTCUT] Physical wake trigger detected: '{self._current_shortcut.upper()}'"
            )
            self.shortcut_wake_event.set()
            if self.on_toggle_callback:
                try:
                    self.on_toggle_callback("wake")
                except Exception as e:
                    print(f"⚠️ [SHORTCUT] Callback error on wake: {e}")
        else:
            print(
                f"\n💤 [SHORTCUT] Physical sleep trigger detected: '{self._current_shortcut.upper()}'"
            )
            self.shortcut_sleep_event.set()
            if self.on_toggle_callback:
                try:
                    self.on_toggle_callback("sleep")
                except Exception as e:
                    print(f"⚠️ [SHORTCUT] Callback error on sleep: {e}")

    def _on_key_event(self, event):
        """Processes low-level keyboard events to detect a standalone Win key tap."""
        is_win_key = (
            event.name in WIN_KEY_NAMES or
            event.scan_code in WIN_SCAN_CODES
        )

        if event.event_type == keyboard.KEY_DOWN:
            if is_win_key:
                if not self._win_down:
                    self._win_down = True
                    self._win_down_time = time.time()
                    self._other_key_pressed = False
            else:
                if self._win_down:
                    # User pressed another key while Win was held (e.g. Win+E, Win+R, Win+H for GlazeWM)
                    self._other_key_pressed = True

        elif event.event_type == keyboard.KEY_UP:
            if is_win_key:
                was_down = self._win_down
                duration = time.time() - self._win_down_time if was_down else 999.0
                had_other = self._other_key_pressed
                self._win_down = False
                self._other_key_pressed = False

                # Clean standalone tap under 500ms with no accompanying keys
                if was_down and not had_other and duration < 0.5:
                    _suppress_start_menu()
                    self._handle_hotkey_press()

    def _cleanup_hooks(self):
        """Safely removes active hooks."""
        if self._active_hotkey_hook is not None:
            try:
                keyboard.remove_hotkey(self._active_hotkey_hook)
            except Exception:
                pass
            self._active_hotkey_hook = None

        if self._active_key_hook is not None:
            try:
                keyboard.unhook(self._active_key_hook)
            except Exception:
                pass
            self._active_key_hook = None

    def start(self) -> bool:
        """Registers the active shortcut globally."""
        if keyboard is None:
            print(
                "⚠️ [SHORTCUT] 'keyboard' library not installed. Physical shortcut disabled."
            )
            return False

        try:
            self._cleanup_hooks()
            with self._lock:
                shortcut_lower = self._current_shortcut.lower().strip()
                if shortcut_lower in ("win", "windows", "left windows", "right windows"):
                    self._active_key_hook = keyboard.hook(self._on_key_event)
                else:
                    self._active_hotkey_hook = keyboard.add_hotkey(
                        self._current_shortcut,
                        self._handle_hotkey_press,
                        suppress=False
                    )
            print(
                f"⌨️ [SHORTCUT] Dynamic Shortcut Detector Online. Hotkey: '{self._current_shortcut.upper()}'"
            )
            return True
        except Exception as e:
            print(
                f"⚠️ [SHORTCUT] Failed to register hotkey '{self._current_shortcut}': {e}"
            )
            return False

    def update_shortcut(self, new_shortcut: str) -> bool:
        """
        Dynamically changes the hotkey at runtime (e.g. from the React UI launcher).
        Validates the new combination, updates fast RAM, and saves to persistent preferences.
        """
        if keyboard is None:
            return False

        clean_shortcut = new_shortcut.strip().lower()
        if not clean_shortcut:
            return False

        if clean_shortcut not in ("win", "windows"):
            try:
                keyboard.parse_hotkey(clean_shortcut)
            except Exception as e:
                print(
                    f"❌ [SHORTCUT] Invalid shortcut combination '{new_shortcut}': {e}"
                )
                return False

        self._cleanup_hooks()
        with self._lock:
            self._current_shortcut = clean_shortcut
            try:
                if clean_shortcut in ("win", "windows", "left windows", "right windows"):
                    self._active_key_hook = keyboard.hook(self._on_key_event)
                else:
                    self._active_hotkey_hook = keyboard.add_hotkey(
                        self._current_shortcut,
                        self._handle_hotkey_press,
                        suppress=False
                    )
            except Exception as e:
                print(f"⚠️ [SHORTCUT] Error registering new hotkey: {e}")
                return False

        config.update_wake_shortcut(clean_shortcut)
        print(
            f"✅ [SHORTCUT] Hotkey dynamically updated to: '{clean_shortcut.upper()}'"
        )
        return True

    def stop(self):
        """Cleans up the hotkey hook on shutdown."""
        self._cleanup_hooks()
        print("🛑 [SHORTCUT] Hotkey detector stopped cleanly.")


_detector_instance: Optional[ShortcutDetector] = None


def init_shortcut_detector(shortcut_wake_event: threading.Event,
                           shortcut_sleep_event: threading.Event,
                           on_toggle_callback: Optional[Callable[[str], None]] = None) -> ShortcutDetector:
    """Initializes and starts the global shortcut detector instance."""
    global _detector_instance
    _detector_instance = ShortcutDetector(
        shortcut_wake_event=shortcut_wake_event,
        shortcut_sleep_event=shortcut_sleep_event,
        on_toggle_callback=on_toggle_callback
    )
    _detector_instance.start()
    return _detector_instance


def get_shortcut_detector() -> Optional[ShortcutDetector]:
    """Returns the active global ShortcutDetector instance."""
    return _detector_instance
