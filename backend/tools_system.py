"""
AVAILABLE SYSTEM TOOLS:
- get_live_location
- manage_system_power
- set_system_brightness
- get_active_windows
- close_application
- analyze_screen_data
- manage_recycle_bin
- launch_app
- list_installed_apps
- open_windows_setting
- get_weather_forecast
- get_currently_playing
- control_media_playback
- set_system_volume
- open_in_browser
- get_bible_passage
"""

import os
import io
import json
import base64
import ctypes
from ctypes import wintypes
import asyncio
import subprocess
import time
import urllib.parse
import webbrowser
from datetime import datetime
import psutil
import requests
import win32gui
import win32process
import win32ui

try:
    import mss
except ImportError:
    mss = None

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    from winrt.windows.devices.geolocation import Geolocator, GeolocationAccessStatus
except ImportError:
    Geolocator = None
    GeolocationAccessStatus = None

try:
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as MediaManager,
    )
except ImportError:
    MediaManager = None

try:
    from pycaw.pycaw import AudioUtilities
except ImportError:
    AudioUtilities = None

try:
    import screen_brightness_control as sbc
except ImportError:
    sbc = None


try:
    from settings_schema import SETTINGS_SCHEMA
except ImportError:
    SETTINGS_SCHEMA = {}

try:
    import app_registry
except ImportError:
    app_registry = None

try:
    from ans import find_aiden_overlay_hwnds, get_visible_desktop_windows
except ImportError:
    from backend.ans import find_aiden_overlay_hwnds, get_visible_desktop_windows


# ---------------------------------------------------------
# 1. LOCATION
# ---------------------------------------------------------

def get_live_location() -> str:
    """Uses Windows Native Wi-Fi Triangulation (WinRT) with OpenStreetMap Nominatim reverse geocoding."""
    async def fetch_windows_location():
        if not Geolocator:
            return {"error": "WinRT geolocation module not available"}
        try:
            print(
                ">> [LOCATION] Querying Windows Native Geolocation (Wi-Fi Triangulation)...")
            geolocator = Geolocator()
            access_status = await Geolocator.request_access_async()
            if access_status != GeolocationAccessStatus.ALLOWED:
                return {"error": "Windows Location access denied. Check Settings > Privacy & Security > Location."}

            pos = await asyncio.wait_for(geolocator.get_geoposition_async(), timeout=8.0)
            if not pos:
                return {"error": "Windows Location Services returned no data."}

            return {
                "lat": pos.coordinate.point.position.latitude,
                "lon": pos.coordinate.point.position.longitude,
                "accuracy": pos.coordinate.accuracy,
                "source": "Windows Native Wi-Fi Triangulation"
            }
        except asyncio.TimeoutError:
            return {"error": "Windows Geolocation request timed out."}
        except Exception as e:
            return {"error": f"WinRT API Error: {str(e)}"}

    try:
        geo_data = None
        if Geolocator:
            try:
                try:
                    geo_data = asyncio.run(fetch_windows_location())
                except RuntimeError:
                    loop = asyncio.get_event_loop()
                    geo_data = loop.run_until_complete(
                        fetch_windows_location())
            except Exception as e:
                geo_data = {"error": str(e)}

        # Fallback to IP-based Geolocation if Windows Location is disabled or fails
        if not geo_data or "error" in geo_data:
            print(
                ">> [LOCATION] Windows GPS unavailable; falling back to IP Geolocation...")
            try:
                ip_res = requests.get("http://ip-api.com/json/", timeout=4.0)
                if ip_res.status_code == 200:
                    ip_data = ip_res.json()
                    if ip_data.get("status") == "success":
                        geo_data = {
                            "lat": ip_data.get("lat"),
                            "lon": ip_data.get("lon"),
                            "accuracy": 5000.0,
                            "source": f"IP Geolocation ({ip_data.get('city')}, {ip_data.get('country')})"
                        }
            except Exception as ip_e:
                print(f">> [LOCATION] IP fallback failed: {ip_e}")

        if not geo_data or "error" in geo_data:
            err_msg = geo_data.get(
                "error", "Unknown error") if geo_data else "Failed to retrieve coordinates"
            return f"System Error retrieving location: {err_msg}"

        lat = geo_data["lat"]
        lon = geo_data["lon"]
        accuracy = geo_data.get("accuracy", 0.0)
        source = geo_data.get("source", "GPS")

        # Reverse Geocoding via OpenStreetMap Nominatim (Free, no API key required)
        readable_address = f"{lat:.4f}, {lon:.4f}"
        try:
            headers = {
                "User-Agent": "AidenAssistant/1.0 (Desktop AI Companion; contact: support@aiden.ai)",
                "Accept": "application/json"
            }
            nom_url = f"https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=jsonv2"
            nom_res = requests.get(nom_url, headers=headers, timeout=5.0)
            if nom_res.status_code == 200:
                nom_data = nom_res.json()
                disp_name = nom_data.get("display_name")
                if disp_name:
                    readable_address = disp_name
        except Exception as geo_e:
            print(f">> [LOCATION] Nominatim reverse geocoding error: {geo_e}")

        # Derive clean display title for the UI card
        clean_title = "My Location"
        if readable_address and readable_address != f"{lat:.4f}, {lon:.4f}":
            parts = [p.strip()
                     for p in readable_address.split(",") if p.strip()]
            if len(parts) >= 2:
                clean_title = f"{parts[0]}, {parts[1]}"
            elif len(parts) == 1:
                clean_title = parts[0]

        card_tag = f"::location-card[lat={lat:.5f} | lon={lon:.5f} | title={clean_title}]::"

        return (
            f"Live Location: {readable_address} | "
            f"Coordinates: {lat:.5f}, {lon:.5f} | "
            f"Accuracy Radius: ~{accuracy:.1f} meters (Source: {source})\n"
            f"Embed this card tag directly in your reply below your answer:\n"
            f"{card_tag}"
        )
    except Exception as e:
        return f"System Error executing location flow: {str(e)}"


# ---------------------------------------------------------
# 2. SYSTEM POWER, BRIGHTNESS & VOLUME
# ---------------------------------------------------------

def manage_system_power(action: str) -> str:
    """Controls the PC's power state: lock, shutdown, restart, hibernate, or abort."""
    action = action.lower().strip()
    try:
        if action == "lock":
            ctypes.windll.user32.LockWorkStation()
            return "System locked successfully."
        elif action == "shutdown":
            os.system(
                'shutdown /s /t 5 /c "A.I.D.E.N. is shutting down the system."')
            return "Shutdown initiated. System will power off in 5 seconds."
        elif action == "restart":
            os.system(
                'shutdown /r /t 5 /c "A.I.D.E.N. is restarting the system."')
            return "Restart initiated. System will reboot in 5 seconds."
        elif action == "hibernate":
            os.system('shutdown /h')
            return "System is going into hibernation."
        elif action == "abort":
            os.system('shutdown /a')
            return "Emergency abort successful. Shutdown/Restart has been canceled."
        else:
            return f"Error: Unrecognized power action '{action}'."
    except Exception as e:
        return f"System Error executing power command: {str(e)}"


def set_system_brightness(level: str) -> str:
    """Sets the Windows master brightness to an absolute percentage or applies a relative change."""
    if not sbc:
        return "Error: 'screen-brightness-control' is not installed. Run 'pip install screen-brightness-control'."
    try:
        current_brightness = sbc.get_brightness(display=0)[0]
        level_str = str(level).strip().rstrip("%")
        if level_str.startswith('+') or level_str.startswith('-'):
            delta = int(level_str)
            target_pct = current_brightness + delta
        else:
            target_pct = int(level_str)

        target_pct = max(0, min(100, target_pct))
        sbc.set_brightness(target_pct, display=0)

        slider_tag = f"::system-slider[type=brightness | level={target_pct}]::"
        return (
            f"System brightness successfully changed from {current_brightness}% to {target_pct}%.\n"
            f"{slider_tag}"
        )
    except Exception as e:
        return f"System Error setting brightness: {str(e)}"


def set_system_volume(level: str) -> str:
    """Sets the Windows master volume to an absolute percentage, applies a relative change, or mutes/unmutes."""
    if not AudioUtilities:
        return "Error: 'pycaw' is not installed. Run 'pip install pycaw'."
    try:
        # Crucial for Windows COM multithreading: initialize COM on the caller thread
        try:
            import comtypes
            comtypes.CoInitialize()
        except Exception:
            try:
                import pythoncom
                pythoncom.CoInitialize()
            except Exception:
                pass

        device = AudioUtilities.GetSpeakers()
        volume = device.EndpointVolume

        current_scalar = volume.GetMasterVolumeLevelScalar()
        current_pct = int(round(current_scalar * 100))

        level_clean = str(level).strip().lower()
        if level_clean == "mute":
            volume.SetMute(1, None)
            slider_tag = f"::system-slider[type=volume | level={current_pct} | muted=true]::"
            return f"System volume muted.\n{slider_tag}"
        elif level_clean == "unmute":
            volume.SetMute(0, None)
            slider_tag = f"::system-slider[type=volume | level={current_pct} | muted=false]::"
            return f"System volume unmuted (current level: {current_pct}%).\n{slider_tag}"

        level_clean = level_clean.rstrip("%")
        if level_clean.startswith('+') or level_clean.startswith('-'):
            delta = int(level_clean)
            target_pct = current_pct + delta
        else:
            target_pct = int(level_clean)

        target_pct = max(0, min(100, target_pct))
        volume.SetMasterVolumeLevelScalar(target_pct / 100.0, None)

        if target_pct > 0 and volume.GetMute():
            volume.SetMute(0, None)
        elif target_pct == 0:
            volume.SetMute(1, None)

        is_muted = bool(volume.GetMute())
        slider_tag = f"::system-slider[type=volume | level={target_pct} | muted={str(is_muted).lower()}]::"
        return (
            f"System volume successfully changed from {current_pct}% to {target_pct}%.\n"
            f"{slider_tag}"
        )
    except Exception as e:
        return f"System Error setting volume: {str(e)}"


# ---------------------------------------------------------
# 3. WINDOWS SETTINGS & RECYCLE BIN
# ---------------------------------------------------------

def open_windows_setting(setting_name: str) -> str:
    """Navigates directly to a designated Windows Settings sub-page or Security panel."""
    target_key = setting_name.lower().strip()
    uri = None

    if target_key in SETTINGS_SCHEMA:
        uri = SETTINGS_SCHEMA[target_key].get("target")
    else:
        for key, data in SETTINGS_SCHEMA.items():
            if target_key in data.get("aliases", []):
                uri = data.get("target")
                break

    if not uri:
        if target_key.startswith("ms-settings:"):
            uri = target_key
        else:
            return f"Error: Setting '{setting_name}' not found in settings registry."

    try:
        print(
            f"\n⚙️ [SETTINGS] Opening Windows Settings: {setting_name} ({uri})...")
        os.startfile(uri)
        return f"Successfully opened Windows Settings for '{setting_name}'."
    except Exception as e:
        return f"System Error opening setting: {str(e)}"


class SHQUERYRBINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint32),
        ("i64Size", ctypes.c_int64),
        ("i64NumItems", ctypes.c_int64)
    ]


def manage_recycle_bin(**kwargs):
    """Hooks into Windows API to check the size or silently empty the Recycle Bin."""
    action = kwargs.get("action", "check").lower()

    try:
        if action == "check":
            info = SHQUERYRBINFO()
            info.cbSize = ctypes.sizeof(info)
            result = ctypes.windll.shell32.SHQueryRecycleBinW(
                None, ctypes.byref(info))

            if result == 0:
                items = info.i64NumItems
                size_mb = info.i64Size / (1024 * 1024)
                if items == 0:
                    return "The Recycle Bin is currently completely empty."
                return f"Recycle Bin Status: {items} items taking up {size_mb:.2f} MB of space."
            else:
                return f"Error querying Recycle Bin. (API Code: {result})"

        elif action == "empty":
            print("\n🗑️ [SYSTEM] Triggering silent Recycle Bin wipe...")
            result = ctypes.windll.shell32.SHEmptyRecycleBinW(None, None, 7)
            if result == 0:
                return "SUCCESS: The Recycle Bin has been completely emptied. Disk space freed."
            else:
                return f"Note: The Recycle Bin is already empty. (API Code: {result})"
        else:
            return "Error: Invalid action. Use 'check' or 'empty'."
    except Exception as e:
        return f"System API Error: {str(e)}"


# ---------------------------------------------------------
# 4. WINDOWS MEDIA TRANSPORT CONTROLS
# ---------------------------------------------------------

def get_currently_playing() -> str:
    """Reads the Windows OS to find what song/media is currently playing."""
    if not MediaManager:
        return "Error: Windows SDK media controls are not installed."

    async def _get_media():
        sessions = await MediaManager.request_async()
        current_session = sessions.get_current_session()
        if current_session:
            info = await current_session.try_get_media_properties_async()
            playback_info = current_session.get_playback_info()
            status = "Playing" if playback_info.playback_status == 4 else "Paused/Stopped"
            return f"[{status}] '{info.title}' by {info.artist}"
        return None

    try:
        try:
            result = asyncio.run(_get_media())
        except RuntimeError:
            loop = asyncio.get_event_loop()
            result = loop.run_until_complete(_get_media())

        if result:
            return f"System Media Status: {result}"
        return "There is currently no media queued or playing on the system."
    except Exception as e:
        return f"System Error reading media: {str(e)}"


async def _get_active_media_session():
    """Helper to retrieve the current Windows media session."""
    if not MediaManager:
        return None
    sessions = await MediaManager.request_async()
    return sessions.get_current_session()


def _run_media_coroutine(coro):
    """Helper to run async Windows media control coroutines safely."""
    try:
        return asyncio.run(coro)
    except RuntimeError:
        loop = asyncio.get_event_loop()
        return loop.run_until_complete(coro)


def media_play() -> str:
    """Resumes or starts playback on the currently active media player (Spotify, YouTube, browser, etc.)."""
    if not MediaManager:
        return "Error: Windows SDK media controls are not installed."

    async def _action():
        session = await _get_active_media_session()
        if not session:
            return "No active media session found to play."
        await session.try_play_async()
        return "Media playback resumed."

    try:
        return _run_media_coroutine(_action())
    except Exception as e:
        return f"Error resuming media: {str(e)}"


def media_pause() -> str:
    """Pauses playback on the currently active media player (Spotify, YouTube, browser, etc.)."""
    if not MediaManager:
        return "Error: Windows SDK media controls are not installed."

    async def _action():
        session = await _get_active_media_session()
        if not session:
            return "No active media session found to pause."
        await session.try_pause_async()
        return "Media playback paused."

    try:
        return _run_media_coroutine(_action())
    except Exception as e:
        return f"Error pausing media: {str(e)}"


def media_next_track() -> str:
    """Skips to the next track in the currently active playlist or queue."""
    if not MediaManager:
        return "Error: Windows SDK media controls are not installed."

    async def _action():
        session = await _get_active_media_session()
        if not session:
            return "No active media session found to skip."
        await session.try_skip_next_async()
        return "Skipped to the next track."

    try:
        return _run_media_coroutine(_action())
    except Exception as e:
        return f"Error skipping to next track: {str(e)}"


def media_previous_track() -> str:
    """
    Navigates back to the previous track in the playlist or queue.
    Executes a rapid double-back command so the player actually returns to the prior track
    rather than just restarting the currently playing song from 0:00.
    """
    if not MediaManager:
        return "Error: Windows SDK media controls are not installed."

    async def _action():
        session = await _get_active_media_session()
        if not session:
            return "No active media session found."
        # First press: resets playback head to 0:00
        await session.try_skip_previous_async()
        # 150ms debounce window satisfying Windows & Spotify double-tap threshold
        await asyncio.sleep(0.15)
        # Second press: jumps back to the prior track in queue
        await session.try_skip_previous_async()
        return "Returned to the previous track."

    try:
        return _run_media_coroutine(_action())
    except Exception as e:
        return f"Error returning to previous track: {str(e)}"


def media_restart_track() -> str:
    """
    Restarts the currently playing track from the beginning (0:00).
    Executes a single back command to seek the track back to its start.
    """
    if not MediaManager:
        return "Error: Windows SDK media controls are not installed."

    async def _action():
        session = await _get_active_media_session()
        if not session:
            return "No active media session found."
        await session.try_skip_previous_async()
        return "Restarted the current track from the beginning."

    try:
        return _run_media_coroutine(_action())
    except Exception as e:
        return f"Error restarting track: {str(e)}"


# ---------------------------------------------------------
# 5. DESKTOP WINDOWS & SCREEN VISION
# ---------------------------------------------------------

def get_active_windows(**kwargs):
    """Scans the OS and returns a list of all visible desktop windows (excluding AIDEN's overlay)."""
    visible_windows = get_visible_desktop_windows()
    if not visible_windows:
        return "No visible windows found on the desktop."

    output = "--- CURRENTLY OPEN WINDOWS ON SCREEN ---\n"
    for w in visible_windows:
        if "python" in w["app"] and not w["is_active"]:
            continue
        if w["is_active"]:
            status = "[🟢 ACTIVE FOCUS]"
        elif w.get("is_minimized"):
            status = "[Minimized]"
        else:
            status = "[Background]"
        output += f"{status} {w['title']} (Process: {w['app']})\n"

    output += "\nSYSTEM NOTE: The [🟢 ACTIVE FOCUS] tag bypasses overlay windows to identify the application in active use."
    return output


def _get_extended_window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    """Returns exact DWM visible frame bounds (excluding drop shadow margin), falling back to GetWindowRect."""
    rect = wintypes.RECT()
    try:
        DWMWA_EXTENDED_FRAME_BOUNDS = 9
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            wintypes.HWND(hwnd),
            ctypes.c_uint(DWMWA_EXTENDED_FRAME_BOUNDS),
            ctypes.byref(rect),
            ctypes.sizeof(rect),
        )
        if hr == 0 and rect.right > rect.left and rect.bottom > rect.top:
            return (rect.left, rect.top, rect.right, rect.bottom)
    except Exception:
        pass
    try:
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        if r > l and b > t:
            return (l, t, r, b)
    except Exception:
        pass
    return None


def _find_monitor_for_hwnd(sct, hwnd: int | None) -> dict:
    """Selects the mss monitor containing the target window center, defaulting to primary."""
    monitors = sct.monitors
    fallback = monitors[1] if len(monitors) > 1 else monitors[0]
    if not hwnd:
        return fallback
    rect = _get_extended_window_rect(hwnd)
    if not rect:
        return fallback
    cx = (rect[0] + rect[2]) // 2
    cy = (rect[1] + rect[3]) // 2
    for mon in monitors[1:]:
        if (
            mon["left"] <= cx < mon["left"] + mon["width"]
            and mon["top"] <= cy < mon["top"] + mon["height"]
        ):
            return mon
    return fallback


def _match_window_by_name(windows: list[dict], query: str) -> dict | None:
    """Ranks visible desktop windows against a name/title query without stealing focus."""
    q = " ".join((query or "").lower().split())
    if not q:
        return None
    q_stem = q.removesuffix(".exe")

    best_win = None
    best_score = -1
    for z_idx, w in enumerate(windows):
        app_l = (w.get("app") or "").lower()
        app_stem = app_l.removesuffix(".exe")
        title_l = (w.get("title") or "").lower()
        if "python" in app_l and not w.get("is_active"):
            continue

        score = 0
        if q_stem == app_stem or q == title_l:
            score = 100
        elif app_stem.startswith(q_stem) or f" {q_stem}" in f" {title_l}":
            score = 65
        elif q_stem in app_stem or q in title_l:
            score = 35

        if score <= 0:
            continue
        if not w.get("is_minimized"):
            score += 15
        if w.get("is_active"):
            score += 5
        # Preserve front-to-back Z-order preference via fractional penalty
        rank = score - (z_idx * 0.01)
        if rank > best_score:
            best_score = rank
            best_win = w
    return best_win


def _is_window_occluded(target_hwnd: int, target_rect: tuple[int, int, int, int], windows: list[dict]) -> bool:
    """Returns True if another visible window higher in Z-order meaningfully covers target_hwnd."""
    tl, tt, tr, tb = target_rect
    area = max(1, (tr - tl) * (tb - tt))
    cx = (tl + tr) // 2
    cy = (tt + tb) // 2

    for w in windows:
        if w["hwnd"] == target_hwnd:
            break
        if w.get("is_minimized"):
            continue
        wr = _get_extended_window_rect(w["hwnd"]) or w.get("rect")
        if not wr:
            continue
        wl, wt, wr_x, wb = wr
        if wl <= cx <= wr_x and wt <= cy <= wb:
            return True
        ix0, iy0 = max(tl, wl), max(tt, wt)
        ix1, iy1 = min(tr, wr_x), min(tb, wb)
        if ix1 > ix0 and iy1 > iy0:
            overlap = (ix1 - ix0) * (iy1 - iy0)
            if (overlap / area) >= 0.08:
                return True
    return False


def _capture_window_printwindow(hwnd: int) -> Image.Image | None:
    """Renders an occluded background window off-screen using PrintWindow (PW_RENDERFULLCONTENT)."""
    if Image is None:
        return None
    try:
        ol, ot, or_x, ob = win32gui.GetWindowRect(hwnd)
    except Exception:
        return None
    rw, rh = or_x - ol, ob - ot
    if rw <= 10 or rh <= 10:
        return None

    hwnd_dc = None
    mfc_dc = None
    save_dc = None
    bitmap = None
    try:
        hwnd_dc = win32gui.GetWindowDC(hwnd)
        mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
        save_dc = mfc_dc.CreateCompatibleDC()
        bitmap = win32ui.CreateBitmap()
        bitmap.CreateCompatibleBitmap(mfc_dc, rw, rh)
        save_dc.SelectObject(bitmap)

        PW_RENDERFULLCONTENT = 2
        ok = ctypes.windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), PW_RENDERFULLCONTENT)
        if not ok:
            return None

        bmp_bits = bitmap.GetBitmapBits(True)
        img = Image.frombuffer("RGB", (rw, rh), bmp_bits, "raw", "BGRX", 0, 1)

        # Strip Windows 11 drop-shadow margins cleanly if extended bounds sit inside GetWindowRect
        ext = _get_extended_window_rect(hwnd)
        if ext:
            cl = max(0, ext[0] - ol)
            ct = max(0, ext[1] - ot)
            cr = min(rw, ext[2] - ol)
            cb = min(rh, ext[3] - ot)
            if cr - cl > 10 and cb - ct > 10:
                img = img.crop((cl, ct, cr, cb))

        # Guard against completely black/blank frames (e.g. hardware-protected DRM surfaces)
        extrema = img.getextrema()
        if all(lo == 0 and hi == 0 for lo, hi in extrema):
            return None
        return img
    except Exception:
        return None
    finally:
        if bitmap is not None:
            try:
                win32gui.DeleteObject(bitmap.GetHandle())
            except Exception:
                pass
        if save_dc is not None:
            try:
                save_dc.DeleteDC()
            except Exception:
                pass
        if mfc_dc is not None:
            try:
                mfc_dc.DeleteDC()
            except Exception:
                pass
        if hwnd_dc is not None:
            try:
                win32gui.ReleaseDC(hwnd, hwnd_dc)
            except Exception:
                pass


def _hide_aiden_overlays_briefly() -> list[int]:
    """Hides AIDEN's own visible overlays briefly so they never obscure captured pixels."""
    hwnds = find_aiden_overlay_hwnds()
    if not hwnds:
        return []
    SW_HIDE = 0
    user32 = ctypes.windll.user32
    for h in hwnds:
        try:
            user32.ShowWindowAsync(wintypes.HWND(h), SW_HIDE)
        except Exception:
            pass
    time.sleep(0.045)
    try:
        ctypes.windll.dwmapi.DwmFlush()
    except Exception:
        pass
    return hwnds


def _restore_aiden_overlays(hwnds: list[int]) -> None:
    """Restores AIDEN overlays without stealing keyboard/window focus."""
    if not hwnds:
        return
    SW_SHOWNA = 8
    user32 = ctypes.windll.user32
    for h in hwnds:
        try:
            user32.ShowWindowAsync(wintypes.HWND(h), SW_SHOWNA)
        except Exception:
            pass


def _encode_vision_image(img: Image.Image, detail: str, is_crop: bool) -> tuple[str, tuple[int, int], int]:
    """Resizes proportionally and encodes to base64 JPEG matching our benchmarked quality/latency targets."""
    work = img if img.mode == "RGB" else img.convert("RGB")
    max_w = 1280 if detail == "low" else 1920
    if work.width > max_w:
        ratio = max_w / float(work.width)
        new_h = max(1, int(round(work.height * ratio)))
        work = work.resize((max_w, new_h), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    if detail == "low":
        work.save(buf, format="JPEG", quality=80, optimize=True)
    elif is_crop:
        work.save(buf, format="JPEG", quality=85, subsampling=0, optimize=True)
    else:
        # Whole-screen high detail sweet spot: 1920px max wide, JPEG quality=82 (~109KB, ~10ms encode)
        work.save(buf, format="JPEG", quality=82, optimize=True)

    raw = buf.getvalue()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:image/jpeg;base64,{b64}", work.size, len(raw)


def look_at_screen(
    scope: str = "whole_screen",
    detail: str = "high",
    window_name: str | None = None,
    **_kwargs,
):
    """
    Captures the user's display or a specific window cleanly in RAM and returns a
    multimodal Responses API payload (`input_text` + `input_image`) for AIDEN to inspect.
    """
    if mss is None or Image is None:
        return "Screen vision error: 'mss' or 'Pillow' dependency is missing."

    norm_detail = "low" if str(detail or "").strip().lower() == "low" else "high"
    win_query = (window_name or "").strip()
    raw_scope = str(scope or "whole_screen").strip().lower()

    if win_query and raw_scope in {"", "whole_screen", "active_screen", "screen", "full_screen"}:
        norm_scope = "window"
    elif raw_scope in {"active_window", "focused_window", "current_window"}:
        norm_scope = "active_window"
    elif raw_scope == "window":
        norm_scope = "window" if win_query else "active_window"
    else:
        norm_scope = "whole_screen"

    hidden_hwnds = _hide_aiden_overlays_briefly()
    captured_img = None
    capture_desc = ""
    is_crop = norm_scope in {"active_window", "window"}

    try:
        windows = get_visible_desktop_windows()
        active_win = next((w for w in windows if w.get("is_active")), None)

        with mss.MSS() as sct:
            vs = sct.monitors[0]

            if norm_scope == "whole_screen":
                mon = _find_monitor_for_hwnd(sct, active_win["hwnd"] if active_win else None)
                raw = sct.grab(mon)
                captured_img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
                active_label = (
                    f"{active_win['app'].removesuffix('.exe')}: {active_win['title']}"
                    if active_win
                    else "Desktop"
                )
                capture_desc = (
                    f"Captured whole monitor ({mon['width']}x{mon['height']}, active focus: {active_label})."
                )
            else:
                if norm_scope == "active_window":
                    target = active_win
                    if not target:
                        return "No visible non-minimized active window was found on the desktop."
                else:
                    target = _match_window_by_name(windows, win_query)
                    if not target:
                        available = [
                            f"{w['app'].removesuffix('.exe')}: {w['title']}"
                            for w in windows[:8]
                            if not ("python" in w["app"] and not w["is_active"])
                        ]
                        avail_str = "; ".join(available) if available else "none"
                        return (
                            f"Could not find an open window matching '{win_query}'. "
                            f"Currently open windows: {avail_str}."
                        )

                if target.get("is_minimized") or win32gui.IsIconic(target["hwnd"]):
                    return (
                        f"The window '{target['title']}' ({target['app']}) is currently minimized to the taskbar "
                        f"and cannot be visually captured while minimized. Ask the user if they'd like to restore/bring it up or capture whole_screen."
                    )

                rect = _get_extended_window_rect(target["hwnd"]) or target.get("rect")
                if not rect:
                    return f"Could not determine screen coordinates for '{target['title']}'."

                occluded = _is_window_occluded(target["hwnd"], rect, windows)
                used_printwindow = False
                if occluded:
                    captured_img = _capture_window_printwindow(target["hwnd"])
                    used_printwindow = captured_img is not None

                if captured_img is None:
                    left = max(vs["left"], rect[0])
                    top = max(vs["top"], rect[1])
                    right = min(vs["left"] + vs["width"], rect[2])
                    bottom = min(vs["top"] + vs["height"], rect[3])
                    cw, ch = right - left, bottom - top
                    if cw <= 10 or ch <= 10:
                        return f"Target window '{target['title']}' is outside visible screen bounds."
                    crop_box = {"left": left, "top": top, "width": cw, "height": ch}
                    raw = sct.grab(crop_box)
                    captured_img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

                method = "offscreen window render" if used_printwindow else "direct window crop"
                overlap_note = " (partially overlapped on desktop)" if (occluded and not used_printwindow) else ""
                capture_desc = (
                    f"Captured window '{target['title']}' ({target['app'].removesuffix('.exe')}) via {method}{overlap_note}."
                )
    except Exception as e:
        err_msg = str(e)
        if "BitBlt" in err_msg or "ScreenShotError" in type(e).__name__:
            return (
                "Screen capture is currently unavailable because Windows blocked desktop capture "
                "(e.g. lock screen, UAC prompt, or asleep display)."
            )
        return f"Error capturing screen: {err_msg}"
    finally:
        _restore_aiden_overlays(hidden_hwnds)

    if captured_img is None:
        return "Screen capture returned an empty frame."

    data_url, out_dims, raw_bytes = _encode_vision_image(captured_img, norm_detail, is_crop)
    size_kb = round(raw_bytes / 1024.0, 1)
    print(f"   👁️ [VISION] {capture_desc} -> {out_dims[0]}x{out_dims[1]} ({size_kb} KB, detail={norm_detail})")

    return [
        {
            "type": "input_text",
            "text": f"{capture_desc} Encoded frame: {out_dims[0]}x{out_dims[1]} JPEG ({size_kb} KB, detail={norm_detail}).",
        },
        {
            "type": "input_image",
            "image_url": data_url,
            "detail": norm_detail,
        },
    ]


def close_application(**kwargs):
    """Force closes an application by its process name using taskkill."""
    process_name = kwargs.get("app_process_name", "").lower().strip()
    if not process_name:
        return "Error: No process name provided."

    if not process_name.endswith(".exe"):
        process_name += ".exe"

    protected_processes = [
        "python.exe", "explorer.exe", "svchost.exe", "systemsettings.exe",
        "taskmgr.exe", "cmd.exe", "powershell.exe", "winlogon.exe"
    ]

    if process_name in protected_processes:
        return f"ACCESS DENIED: '{process_name}' is a protected system process. You cannot terminate it."

    try:
        print(f"\n🛑 [SYSTEM] Attempting to force-close: {process_name}...")
        exit_code = os.system(f'taskkill /IM "{process_name}" /T /F')
        if exit_code == 0:
            return f"Success: Force closed {process_name}."
        else:
            return f"Error: Could not close {process_name}. It might not be running or requires administrator privileges."
    except Exception as e:
        return f"System Error executing taskkill: {str(e)}"

# ---------------------------------------------------------
# 6. APP LAUNCHER & DISCOVERY (RAM / REGISTRY SYNC)
# ---------------------------------------------------------


def launch_app(app_name: str) -> str:
    """Launches an installed desktop application, Store app, or registered program on the user's PC."""
    raw_apps = app_name.lower().replace(" and ", ",").split(",")
    results = []

    for raw_app in raw_apps:
        clean_name = raw_app.strip()
        if not clean_name:
            continue

        app_data = None
        if app_registry:
            app_data = app_registry.get_app_target(clean_name)

        if not app_data and os.path.exists("app_registry.json"):
            try:
                with open("app_registry.json", "r", encoding="utf-8") as f:
                    file_reg = json.load(f).get("available_apps", {})
                    if clean_name in file_reg:
                        app_data = file_reg[clean_name]
                    else:
                        for k, v in file_reg.items():
                            if clean_name in v.get("aliases", []):
                                app_data = v
                                break
            except Exception:
                pass

        if app_data:
            app_type = app_data.get("type")
            target = app_data.get("target")
            display_name = app_data.get("display_name")

            try:
                print(f"\n🚀 [SYSTEM] Launching: {display_name}...")
                if app_type in ["UWP/PWA", "Win32/Shortcut"]:
                    subprocess.Popen(
                        f'explorer.exe "shell:AppsFolder\\{target}"', shell=True)
                elif app_type == "Registry Executable":
                    app_folder = os.path.dirname(target)
                    if app_folder and os.path.exists(app_folder):
                        subprocess.Popen(
                            f'start "" "{target}"', cwd=app_folder, shell=True)
                    else:
                        os.startfile(target)
                else:
                    results.append(
                        f"Error: Unknown execution type '{app_type}' for {display_name}.")
                    continue

                results.append(f"Successfully launched {display_name}.")
            except Exception as e:
                results.append(
                    f"System Error launching {display_name}: {str(e)}")
        else:
            results.append(
                f"Error: The app '{clean_name}' was not found on this system.")

    return " ".join(results)


def list_installed_apps() -> str:
    """Returns a formatted list of all apps currently discovered on the system."""
    installed_list = []

    if app_registry:
        with app_registry._registry_lock:
            for key, data in app_registry._master_apps.items():
                installed_list.append(
                    f"- {data.get('display_name')} (Type: {data.get('type')})")

    if not installed_list and os.path.exists("app_registry.json"):
        try:
            with open("app_registry.json", "r", encoding="utf-8") as f:
                apps = json.load(f).get("available_apps", {})
                for key, data in apps.items():
                    installed_list.append(
                        f"- {data.get('display_name')} (Type: {data.get('type')})")
        except Exception:
            pass

    if not installed_list:
        return "The system app registry is currently empty or scanning."

    return f"Here are the {len(installed_list)} apps currently discovered on the system:\n" + "\n".join(installed_list)


# ---------------------------------------------------------
# 7. WEATHER & UTILITIES
# ---------------------------------------------------------

def get_weather_forecast(location: str) -> str:
    """Fetches live weather and forecast data from Open-Meteo for the LLM to summarize."""
    WMO_MAP = {
        0: ("Clear sky", "☀️"), 1: ("Mainly clear", "🌤️"), 2: ("Partly cloudy", "⛅"),
        3: ("Overcast", "☁️"), 45: ("Fog", "🌫️"), 48: ("Rime fog", "🌫️"),
        51: ("Light drizzle", "🌦️"), 53: ("Moderate drizzle", "🌦️"), 55: ("Dense drizzle", "🌧️"),
        61: ("Slight rain", "🌧️"), 63: ("Moderate rain", "🌧️"), 65: ("Heavy rain", "🌧️"),
        71: ("Slight snow", "🌨️"), 73: ("Moderate snow", "🌨️"), 75: ("Heavy snow", "❄️"),
        80: ("Slight rain showers", "🌦️"), 81: ("Moderate showers", "🌧️"), 82: ("Violent showers", "⛈️"),
        95: ("Thunderstorm", "⛈️"), 96: ("Thunderstorm (hail)", "⛈️"), 99: ("Severe Thunderstorm", "⛈️")
    }

    clean_loc = location.strip()
    encoded_loc = urllib.parse.quote(clean_loc)
    print(f"\n🌤️ [WEATHER] Fetching live weather data for: '{clean_loc}'...")

    try:
        geo_url = f"https://geocoding-api.open-meteo.com/v1/search?name={encoded_loc}&count=1&language=en&format=json"
        geo_resp = requests.get(geo_url, timeout=8.0)
        geo_resp.raise_for_status()
        geo_data = geo_resp.json()

        if "results" not in geo_data or not geo_data["results"]:
            return f"❌ Location '{location}' not found."

        loc = geo_data["results"][0]
        lat, lon = loc["latitude"], loc["longitude"]
        country_code = loc.get("country_code", "")
        admin1 = loc.get("admin1", "")
        if country_code == "US" and admin1:
            city_display = f"{loc.get('name', location)}, {admin1}"
        elif country_code:
            city_display = f"{loc.get('name', location)}, {country_code}"
        else:
            city_display = loc.get('name', location)

        forecast_url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            "&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code,is_day"
            "&hourly=temperature_2m,precipitation_probability,weather_code"
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
            "&timezone=auto"
        )
        data = requests.get(forecast_url, timeout=8.0).json()

        curr = data.get("current", {})
        weather_code = curr.get("weather_code", 0)
        cond_text, icon = WMO_MAP.get(weather_code, ("Unknown", "☁️"))
        current_temp = int(round(curr.get("temperature_2m", 0)))
        feels_like = int(round(curr.get("apparent_temperature", 0)))
        wind_speed = curr.get("wind_speed_10m", 0)
        is_day = bool(curr.get("is_day", 1))

        # Dynamic Condition Key for Apple Siri Card
        if weather_code == 0:
            cond_key = "sunny" if is_day else "clear-night"
        elif weather_code in (1, 2):
            cond_key = "cloudy" if is_day else "cloudy-night"
        elif weather_code == 3:
            cond_key = "overcast" if is_day else "overcast-night"
        elif weather_code in (45, 48):
            cond_key = "fog" if is_day else "fog-night"
        elif weather_code in (51, 53, 55, 61, 63, 65, 80, 81, 82):
            cond_key = "rain" if is_day else "rain-night"
        elif weather_code in (71, 73, 75, 77, 85, 86):
            cond_key = "snow" if is_day else "snow-night"
        elif weather_code in (95, 96, 99):
            cond_key = "thunderstorm" if is_day else "thunderstorm-night"
        else:
            cond_key = "cloudy" if is_day else "cloudy-night"

        output = [
            f"--- LIVE WEATHER DATA FOR {city_display.upper()} ---",
            f"Condition: {cond_text} {icon}",
            f"Temperature: {current_temp}°C (Feels like: {feels_like}°C)",
            f"Wind Speed: {wind_speed} km/h\n",
            "--- 24-HOUR FORECAST ---"
        ]

        hourly = data.get("hourly", {})
        curr_obj = datetime.strptime(
            curr.get("time", ""), "%Y-%m-%dT%H:%M") if curr.get("time") else datetime.now()
        start_idx = next((i for i, t in enumerate(hourly.get(
            "time", [])) if datetime.strptime(t, "%Y-%m-%dT%H:%M") >= curr_obj), 0)

        for i in range(start_idx, min(start_idx + 24, len(hourly.get("time", []))), 3):
            dt = datetime.strptime(hourly["time"][i], "%Y-%m-%dT%H:%M")
            day_lbl = "Today" if dt.date() == curr_obj.date() else "Tomorrow"
            h_cond, h_icon = WMO_MAP.get(hourly["weather_code"][i], ("", ""))
            temp = int(round(hourly["temperature_2m"][i]))
            rain_prob = hourly["precipitation_probability"][i]
            output.append(
                f"• {day_lbl} {dt.strftime('%I:%M %p')}: {h_cond} {h_icon}, {temp}°C (Rain chance: {rain_prob}%)")

        daily = data.get("daily", {})
        dates = daily.get("time", [])
        if dates:
            output.append("\n--- 5-DAY DAILY OVERVIEW ---")
            for i in range(min(5, len(dates))):
                d_obj = datetime.strptime(dates[i], "%Y-%m-%d")
                d_name = "Today" if i == 0 else d_obj.strftime("%A (%b %d)")
                max_t = int(round(daily["temperature_2m_max"][i]))
                min_t = int(round(daily["temperature_2m_min"][i]))
                d_cond, d_icon = WMO_MAP.get(
                    daily["weather_code"][i], ("", ""))
                output.append(
                    f"• {d_name}: {d_cond} {d_icon} | High: {max_t}°C / Low: {min_t}°C")

        daily = data.get("daily", {})
        max_temps = daily.get("temperature_2m_max", [])
        min_temps = daily.get("temperature_2m_min", [])
        today_high = int(round(max_temps[0])) if max_temps else current_temp
        today_low = int(round(min_temps[0])) if min_temps else current_temp

        weather_card_data = {
            "location": city_display,
            "temp": current_temp,
            "tempHigh": today_high,
            "tempLow": today_low,
            "unit": "C",
            "condition": cond_text,
            "conditionKey": cond_key,
            "weatherCode": weather_code,
            "isDay": is_day
        }
        card_tag = f"::weather-card[{json.dumps(weather_card_data)}]::"

        return f"{card_tag}\n\n" + "\n".join(output)
    except Exception as e:
        return f"❌ Weather API Error: {str(e)}"


def open_in_browser(url: str, mode: str = "inbuilt") -> str:
    """Delegates to tools_browser.open_in_browser (inbuilt Aiden Browser by default)."""
    import tools_browser

    return tools_browser.open_in_browser(url=url, mode=mode)


def get_bible_passage(reference: str, translation: str = "web") -> str:
    """Fetches Bible verses or chapters directly from bible-api.com with verse formatting."""
    try:
        cleaned_ref = reference.strip()
        if not cleaned_ref:
            return "❌ Error: Empty scripture reference provided."

        translation_clean = translation.lower().strip()
        supported_translations = {"web", "kjv", "bbe",
                                  "oeb-us", "oeb-cw", "webbe", "almeida", "rvr"}

        if translation_clean not in supported_translations:
            translation_clean = "web"

        encoded_ref = urllib.parse.quote(cleaned_ref, safe=':')
        url = f"https://bible-api.com/{encoded_ref}?translation={translation_clean}"

        response = requests.get(url, timeout=6.0)
        if response.status_code != 200:
            return f"❌ Error: Could not retrieve '{reference}'. Please check book name and chapter/verse numbers."

        data = response.json()
        if "error" in data:
            return f"❌ Bible API Error: {data['error']}"

        verses_list = data.get("verses", [])
        if verses_list:
            formatted_verses = []
            for v in verses_list:
                v_num = v.get("verse", "")
                v_text = v.get("text", "").strip()
                formatted_verses.append(f"[{v_num}] {v_text}")
            passage_text = "\n".join(formatted_verses)
        else:
            passage_text = data.get("text", "").strip()

        MAX_CHARS = 8000
        if len(passage_text) > MAX_CHARS:
            passage_text = passage_text[:MAX_CHARS] + \
                "\n\n[... Passage truncated for length ...]"

        # Directly return the formatted text rather than a UI payload since we are bypassing the old UI rendering
        return f"--- BIBLE PASSAGE: {data.get('reference', reference)} ({data.get('translation_name', translation_clean.upper())}) ---\n{passage_text}"

    except Exception as e:
        return f"❌ Error executing Bible lookup: {str(e)}"


# ---------------------------------------------------------
# 19. GROUNDED WEB SEARCH TOOL (OPENAI REAL-TIME RESPONSES)
# ---------------------------------------------------------

def grounded_web_search(query: str, search_context: str = "low") -> str:
    """
    Performs real-time, grounded web search using OpenAI's native Responses engine.
    Fetches verified facts, recent events, breaking news, live statistics, and source links.
    """
    try:
        from auth_manager import get_api_key
        from openai import OpenAI

        api_key = get_api_key()
        if not api_key:
            return "Error: No OpenAI API key found for web search."

        client = OpenAI(api_key=api_key)

        depth = search_context.lower() if search_context in [
            "low", "medium", "high"] else "low"

        print(
            f"   [WEB SEARCH]: Querying live web via gpt-6-luna (Depth: {depth}): '{query}'")

        resp = client.responses.create(
            model="gpt-6-luna",
            input=(
                f"Search the live web for:\n"
                f"\"{query}\"\n\n"
                f"Perform a fast, targeted search. Extract verified facts, dates, context, and sources directly from search snippets without crawling extraneous full web pages. Focus on accuracy and concrete source attribution."
            ),
            tools=[{"type": "web_search", "search_context_size": depth}]
        )

        text_parts = []
        raw_citations = []

        for item in resp.output:
            if hasattr(item, "content"):
                for c in item.content:
                    if hasattr(c, "text") and c.text:
                        text_parts.append(c.text)
                    if hasattr(c, "annotations") and c.annotations:
                        for ann in c.annotations:
                            if getattr(ann, "type", None) == "url_citation":
                                raw_citations.append({
                                    "title": getattr(ann, "title", "Source"),
                                    "url": getattr(ann, "url", "")
                                })

        full_grounded_text = "".join(text_parts).strip()
        if not full_grounded_text:
            return f"No grounded results could be extracted for query: '{query}'."

        # Deduplicate citations by URL
        seen_urls = set()
        unique_sources = []
        for cit in raw_citations:
            u = cit.get("url")
            if u and u not in seen_urls:
                seen_urls.add(u)
                unique_sources.append(cit)

        formatted_sources = (
            "\n".join(
                [f"• [{s['title']}]({s['url']})" for s in unique_sources])
            if unique_sources
            else "None explicitly provided."
        )

        return (
            f"=== GROUNDED WEB SEARCH RESULTS: \"{query}\" ===\n"
            f"{full_grounded_text}\n\n"
            f"=== VERIFIED SOURCES ===\n"
            f"{formatted_sources}\n\n"
            f"[SYSTEM DIRECTIVE: Synthesize the verified facts above conversationally for the user in your signature Aiden persona. Do not copy raw markdown headers like ## or ###; format sections using numbers or capitalized titles and bullets. "
            f"Ground your answer entirely in these verified findings. At the end of your response, list the most relevant sources "
            f"as clickable Markdown bullets: • [Source Title](URL). NEVER state you lack real-time information.]"
        )

    except Exception as e:
        return f"Error executing grounded web search: {str(e)}"


# ---------------------------------------------------------
# MASTER EXPORT BUCKET
# ---------------------------------------------------------

SYSTEM_TOOLS = {
    "look_at_screen": look_at_screen,
    "grounded_web_search": grounded_web_search,
    "get_live_location": get_live_location,
    "manage_system_power": manage_system_power,
    "set_system_brightness": set_system_brightness,
    "get_active_windows": get_active_windows,
    "close_application": close_application,
    "manage_recycle_bin": manage_recycle_bin,
    "launch_app": launch_app,
    "list_installed_apps": list_installed_apps,
    "open_windows_setting": open_windows_setting,
    "get_weather_forecast": get_weather_forecast,
    "get_currently_playing": get_currently_playing,
    "media_play": media_play,
    "media_pause": media_pause,
    "media_next_track": media_next_track,
    "media_previous_track": media_previous_track,
    "media_restart_track": media_restart_track,
    "set_system_volume": set_system_volume,
    "open_in_browser": open_in_browser,
    "get_bible_passage": get_bible_passage
}
