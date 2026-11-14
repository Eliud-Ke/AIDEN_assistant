"""
Dynamic Physical Shortcut Detector for AIDEN.
Uses Win32 RegisterHotKey (MOD_NOREPEAT) as the primary global hotkey backend
for modifier+key combinations (default: Ctrl + Shift + Space), eliminating
Windows Shell conflicts and low-level hook modifier-state drift.
"""

import ctypes
from ctypes import wintypes
import sys
import threading
import time
from typing import Callable, Optional, Tuple

# Ensure Windows stdout handles UTF-8 cleanly
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    import keyboard
except ImportError:
    keyboard = None

from configuration import config

DEFAULT_SHORTCUT = "ctrl+shift+space"

# Win32 constants
_MOD_ALT = 0x0001
_MOD_CONTROL = 0x0002
_MOD_SHIFT = 0x0004
_MOD_WIN = 0x0008
_MOD_NOREPEAT = 0x4000
_WM_QUIT = 0x0012
_WM_HOTKEY = 0x0312
_PM_NOREMOVE = 0x0000
_HOTKEY_ID = 0xA1D3

_WIN_STANDALONE_NAMES = frozenset({"win", "windows", "left windows", "right windows"})
_WIN_SCAN_CODES = frozenset({91, 92, 57435, 57436})

_MODIFIER_MAP = {
    "alt": _MOD_ALT,
    "left alt": _MOD_ALT,
    "right alt": _MOD_ALT,
    "lalt": _MOD_ALT,
    "ralt": _MOD_ALT,
    "ctrl": _MOD_CONTROL,
    "control": _MOD_CONTROL,
    "left ctrl": _MOD_CONTROL,
    "right ctrl": _MOD_CONTROL,
    "lctrl": _MOD_CONTROL,
    "rctrl": _MOD_CONTROL,
    "shift": _MOD_SHIFT,
    "left shift": _MOD_SHIFT,
    "right shift": _MOD_SHIFT,
    "lshift": _MOD_SHIFT,
    "rshift": _MOD_SHIFT,
    "win": _MOD_WIN,
    "windows": _MOD_WIN,
    "left windows": _MOD_WIN,
    "right windows": _MOD_WIN,
}

_VK_MAP = {
    "space": 0x20,
    "tab": 0x09,
    "enter": 0x0D,
    "return": 0x0D,
    "esc": 0x1B,
    "escape": 0x1B,
    "backspace": 0x08,
    "delete": 0x2E,
    "del": 0x2E,
    "insert": 0x2D,
    "ins": 0x2D,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "page up": 0x21,
    "pagedown": 0x22,
    "page down": 0x22,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "capslock": 0x14,
    "caps lock": 0x14,
}
for _fn in range(1, 25):
    _VK_MAP[f"f{_fn}"] = 0x6F + _fn


if sys.platform == "win32" and hasattr(ctypes, "windll"):
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    _user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
    _user32.RegisterHotKey.restype = wintypes.BOOL
    _user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
    _user32.UnregisterHotKey.restype = wintypes.BOOL
    _user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    _user32.GetMessageW.restype = wintypes.BOOL
    _user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
    _user32.PeekMessageW.restype = wintypes.BOOL
    _user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    _user32.PostThreadMessageW.restype = wintypes.BOOL
    _user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_size_t]
    _user32.VkKeyScanW.argtypes = [wintypes.WCHAR]
    _user32.VkKeyScanW.restype = ctypes.c_short
    _kernel32.GetCurrentThreadId.argtypes = []
    _kernel32.GetCurrentThreadId.restype = wintypes.DWORD
else:
    _user32 = None
    _kernel32 = None


def _suppress_start_menu():
    """Sends unassigned dummy virtual key 0xE8 to cancel Windows Start Menu popup."""
    if _user32:
        try:
            _user32.keybd_event(0xE8, 0, 0, 0)
            _user32.keybd_event(0xE8, 0, 2, 0)
        except Exception:
            pass


def _parse_win32_hotkey(shortcut: str) -> Optional[Tuple[int, int]]:
    """Parses strings like 'ctrl+shift+space' into (modifiers, vk_code) for RegisterHotKey."""
    if not _user32:
        return None
    parts = [p.strip().lower() for p in shortcut.split("+") if p.strip()]
    if len(parts) < 2:
        return None

    mods = 0
    vk: Optional[int] = None
    for part in parts:
        if part in _MODIFIER_MAP:
            mods |= _MODIFIER_MAP[part]
        elif vk is None:
            if part in _VK_MAP:
                vk = _VK_MAP[part]
            elif len(part) == 1 and part.isalnum():
                vk = ord(part.upper())
            elif len(part) == 1:
                scan = _user32.VkKeyScanW(part)
                if scan != -1:
                    vk = scan & 0xFF
        else:
            return None

    if mods == 0 or vk is None:
        return None
    return (mods, vk)


class ShortcutDetector:
    """Manages dynamic system-wide physical shortcut detection."""

    def __init__(
        self,
        shortcut_wake_event: threading.Event,
        shortcut_sleep_event: threading.Event,
        on_toggle_callback: Optional[Callable[[str], None]] = None,
    ):
        self.shortcut_wake_event = shortcut_wake_event
        self.shortcut_sleep_event = shortcut_sleep_event
        self.on_toggle_callback = on_toggle_callback

        self._lock = threading.Lock()
        self._current_state = "sleeping"  # "sleeping" or "awake"
        self._active_hotkey_hook = None
        self._active_key_hook = None
        self._win32_thread: Optional[threading.Thread] = None
        self._win32_thread_id: Optional[int] = None
        self._current_shortcut = config.prefs.wake_shortcut or DEFAULT_SHORTCUT
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
            shortcut_label = self._current_shortcut.upper()

        if state == "sleeping":
            print(f"\n⚡ [SHORTCUT] Physical wake trigger detected: '{shortcut_label}'")
            self.shortcut_wake_event.set()
            if self.on_toggle_callback:
                try:
                    self.on_toggle_callback("wake")
                except Exception as e:
                    print(f"⚠️ [SHORTCUT] Callback error on wake: {e}")
        else:
            print(f"\n💤 [SHORTCUT] Physical sleep trigger detected: '{shortcut_label}'")
            self.shortcut_sleep_event.set()
            if self.on_toggle_callback:
                try:
                    self.on_toggle_callback("sleep")
                except Exception as e:
                    print(f"⚠️ [SHORTCUT] Callback error on sleep: {e}")

    def _on_key_event(self, event):
        """Processes low-level keyboard events to detect a standalone Win key tap."""
        is_win_key = (
            event.name in _WIN_STANDALONE_NAMES or
            event.scan_code in _WIN_SCAN_CODES
        )

        if event.event_type == keyboard.KEY_DOWN:
            if is_win_key:
                if not self._win_down:
                    self._win_down = True
                    self._win_down_time = time.time()
                    self._other_key_pressed = False
            else:
                if self._win_down:
                    self._other_key_pressed = True

        elif event.event_type == keyboard.KEY_UP:
            if is_win_key:
                was_down = self._win_down
                duration = time.time() - self._win_down_time if was_down else 999.0
                had_other = self._other_key_pressed
                self._win_down = False
                self._other_key_pressed = False

                if was_down and not had_other and duration < 0.5:
                    _suppress_start_menu()
                    self._handle_hotkey_press()

    def _cleanup_hooks(self):
        """Safely removes Win32 RegisterHotKey threads and fallback keyboard hooks."""
        if self._win32_thread_id is not None and _user32:
            try:
                _user32.PostThreadMessageW(self._win32_thread_id, _WM_QUIT, 0, 0)
            except Exception:
                pass
        if self._win32_thread is not None and self._win32_thread.is_alive():
            self._win32_thread.join(timeout=1.0)
        self._win32_thread = None
        self._win32_thread_id = None

        if self._active_hotkey_hook is not None and keyboard is not None:
            try:
                keyboard.remove_hotkey(self._active_hotkey_hook)
            except Exception:
                pass
            self._active_hotkey_hook = None

        if self._active_key_hook is not None and keyboard is not None:
            try:
                keyboard.unhook(self._active_key_hook)
            except Exception:
                pass
            self._active_key_hook = None

    def _start_win32_hotkey(self, mods: int, vk: int) -> Tuple[bool, int]:
        """Registers a native Win32 hotkey on a dedicated message-loop thread."""
        if not (_user32 and _kernel32):
            return False, -1

        ready_event = threading.Event()
        result = {"ok": False, "err": 0, "tid": None}

        def _msg_loop():
            tid = _kernel32.GetCurrentThreadId()
            result["tid"] = tid

            # Ensure thread message queue exists before PostThreadMessageW can target it
            msg = wintypes.MSG()
            _user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, _PM_NOREMOVE)

            ctypes.set_last_error(0)
            registered = bool(_user32.RegisterHotKey(None, _HOTKEY_ID, mods | _MOD_NOREPEAT, vk))
            err = ctypes.get_last_error() if not registered else 0
            result["ok"] = registered
            result["err"] = err
            ready_event.set()

            if not registered:
                return

            try:
                while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                    if msg.message == _WM_HOTKEY and msg.wParam == _HOTKEY_ID:
                        self._handle_hotkey_press()
            finally:
                _user32.UnregisterHotKey(None, _HOTKEY_ID)

        thread = threading.Thread(target=_msg_loop, name="aiden-win32-hotkey", daemon=True)
        thread.start()
        ready_event.wait(timeout=2.0)

        if result["ok"]:
            self._win32_thread = thread
            self._win32_thread_id = result["tid"]
            return True, 0

        thread.join(timeout=0.5)
        return False, result["err"]

    def _register_shortcut(self, shortcut: str) -> bool:
        """Registers standalone Win hook or native Win32 hotkey (with keyboard fallback)."""
        shortcut_lower = shortcut.lower().strip()

        if shortcut_lower in _WIN_STANDALONE_NAMES:
            if keyboard is None:
                print("⚠️ [SHORTCUT] 'keyboard' library not installed for standalone Win key.")
                return False
            self._active_key_hook = keyboard.hook(self._on_key_event)
            return True

        parsed = _parse_win32_hotkey(shortcut_lower)
        if parsed is not None:
            mods, vk = parsed
            ok, err = self._start_win32_hotkey(mods, vk)
            if ok:
                return True
            if err == 1409:
                print(
                    f"⚠️ [SHORTCUT] Win32 RegisterHotKey conflict for '{shortcut.upper()}' "
                    "(already claimed by another app). Falling back to low-level hook..."
                )
            else:
                print(
                    f"⚠️ [SHORTCUT] Win32 RegisterHotKey failed for '{shortcut.upper()}' (err={err}). "
                    "Falling back to low-level hook..."
                )

        if keyboard is None:
            print(f"⚠️ [SHORTCUT] Could not register '{shortcut}' (Win32 failed and 'keyboard' missing).")
            return False

        self._active_hotkey_hook = keyboard.add_hotkey(
            shortcut_lower,
            self._handle_hotkey_press,
            suppress=False,
        )
        return True

    def start(self) -> bool:
        """Registers the active shortcut globally."""
        try:
            self._cleanup_hooks()
            with self._lock:
                ok = self._register_shortcut(self._current_shortcut)
                label = self._current_shortcut.upper()
            if ok:
                backend_tag = "Win32 RegisterHotKey" if self._win32_thread else "keyboard hook"
                print(f"⌨️ [SHORTCUT] Dynamic Shortcut Detector Online ({backend_tag}). Hotkey: '{label}'")
            return ok
        except Exception as e:
            print(f"⚠️ [SHORTCUT] Failed to register hotkey '{self._current_shortcut}': {e}")
            return False

    def update_shortcut(self, new_shortcut: str) -> bool:
        """
        Dynamically changes the hotkey at runtime (e.g. from the UI launcher).
        Validates the new combination, updates fast RAM, and saves to persistent preferences.
        """
        clean_shortcut = new_shortcut.strip().lower()
        if not clean_shortcut:
            return False

        if clean_shortcut not in _WIN_STANDALONE_NAMES and _parse_win32_hotkey(clean_shortcut) is None:
            if keyboard is None:
                return False
            try:
                keyboard.parse_hotkey(clean_shortcut)
            except Exception as e:
                print(f"❌ [SHORTCUT] Invalid shortcut combination '{new_shortcut}': {e}")
                return False

        self._cleanup_hooks()
        with self._lock:
            self._current_shortcut = clean_shortcut
            try:
                ok = self._register_shortcut(clean_shortcut)
            except Exception as e:
                print(f"⚠️ [SHORTCUT] Error registering new hotkey: {e}")
                return False

        if not ok:
            return False

        config.update_wake_shortcut(clean_shortcut)
        print(f"✅ [SHORTCUT] Hotkey dynamically updated to: '{clean_shortcut.upper()}'")
        return True

    def stop(self):
        """Cleans up the hotkey hook on shutdown."""
        self._cleanup_hooks()
        print("🛑 [SHORTCUT] Hotkey detector stopped cleanly.")


_detector_instance: Optional[ShortcutDetector] = None


def init_shortcut_detector(
    shortcut_wake_event: threading.Event,
    shortcut_sleep_event: threading.Event,
    on_toggle_callback: Optional[Callable[[str], None]] = None,
) -> ShortcutDetector:
    """Initializes and starts the global shortcut detector instance."""
    global _detector_instance
    _detector_instance = ShortcutDetector(
        shortcut_wake_event=shortcut_wake_event,
        shortcut_sleep_event=shortcut_sleep_event,
        on_toggle_callback=on_toggle_callback,
    )
    _detector_instance.start()
    return _detector_instance


def get_shortcut_detector() -> Optional[ShortcutDetector]:
    """Returns the active global ShortcutDetector instance."""
    return _detector_instance
