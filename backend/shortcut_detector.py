"""
Dynamic Physical Shortcut Detector for AIDEN.
Supports global hotkeys (default: Windows + Space) to toggle AIDEN between
Sleep Mode and Awake Mode. Allows runtime customization for the UI app launcher.
"""

import sys
import time
import threading
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
        self._current_shortcut = config.prefs.wake_shortcut or "windows+space"
        self._last_trigger_time = 0.0

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
            # Debounce cooldown: ignore key-repeat signals within 0.8 seconds
            if now - self._last_trigger_time < 0.8:
                return
            self._last_trigger_time = now
            state = self._current_state

        if state == "sleeping":
            print(
                f"\n⚡ [SHORTCUT] Physical wake trigger detected: '{self._current_shortcut}'"
            )
            self.shortcut_wake_event.set()
            if self.on_toggle_callback:
                try:
                    self.on_toggle_callback("wake")
                except Exception as e:
                    print(f"⚠️ [SHORTCUT] Callback error on wake: {e}")
        else:
            print(
                f"\n💤 [SHORTCUT] Physical sleep trigger detected: '{self._current_shortcut}'"
            )
            self.shortcut_sleep_event.set()
            if self.on_toggle_callback:
                try:
                    self.on_toggle_callback("sleep")
                except Exception as e:
                    print(f"⚠️ [SHORTCUT] Callback error on sleep: {e}")

    def start(self) -> bool:
        """Registers the active shortcut globally."""
        if keyboard is None:
            print(
                "⚠️ [SHORTCUT] 'keyboard' library not installed. Physical shortcut disabled."
            )
            return False

        try:
            with self._lock:
                if self._active_hotkey_hook is not None:
                    try:
                        keyboard.remove_hotkey(self._active_hotkey_hook)
                    except Exception:
                        pass

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

        try:
            keyboard.parse_hotkey(clean_shortcut)
        except Exception as e:
            print(
                f"❌ [SHORTCUT] Invalid shortcut combination '{new_shortcut}': {e}"
            )
            return False

        with self._lock:
            if self._active_hotkey_hook is not None:
                try:
                    keyboard.remove_hotkey(self._active_hotkey_hook)
                except Exception:
                    pass

            self._current_shortcut = clean_shortcut
            try:
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
        if keyboard and self._active_hotkey_hook is not None:
            try:
                keyboard.remove_hotkey(self._active_hotkey_hook)
                self._active_hotkey_hook = None
                print("🛑 [SHORTCUT] Hotkey detector stopped cleanly.")
            except Exception:
                pass


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
