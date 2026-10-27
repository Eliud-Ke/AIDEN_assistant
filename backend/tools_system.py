"""
AVAILABLE SYSTEM TOOLS:
- get_system_telemetry
- get_current_time_date
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
import ctypes
import asyncio
import subprocess
import urllib.parse
import webbrowser
from datetime import datetime
import psutil
import requests
import win32gui
import win32process

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


# ---------------------------------------------------------
# 1. HARDWARE TELEMETRY & CLOCK
# ---------------------------------------------------------

def get_system_telemetry():
    """Returns CPU, RAM, and Battery usage as a string."""
    try:
        cpu = psutil.cpu_percent(interval=0.5)
        ram = psutil.virtual_memory().percent
        battery = psutil.sensors_battery()

        if battery:
            bat_str = f"Battery is at {battery.percent}% {'(Plugged In)' if battery.power_plugged else '(Discharging)'}."
        else:
            bat_str = "No battery detected (Desktop mode)."

        return f"CPU Usage: {cpu}%. RAM Usage: {ram}%. {bat_str}"
    except Exception as e:
        return f"Error retrieving telemetry: {str(e)}"


def get_current_time_date():
    """Returns the current date and time as a string."""
    try:
        now = datetime.now()
        return now.strftime("Today is %A, %B %d, %Y. The current time is %I:%M %p.")
    except Exception as e:
        return f"Error fetching time: {str(e)}"


def get_live_location() -> str:
    """Uses Windows Native Wi-Fi Triangulation (WinRT) for high-precision physical location."""
    if not Geolocator:
        return "Error: Windows SDK geolocation modules are not installed."

    async def fetch_windows_location():
        try:
            print(
                "\n📡 [SYSTEM] Querying Windows Native Geolocation (Wi-Fi Triangulation)...")
            geolocator = Geolocator()
            access_status = await Geolocator.request_access_async()
            if access_status != GeolocationAccessStatus.ALLOWED:
                return {"error": "Windows Location access denied. Check Settings > Privacy & Security > Location."}

            pos = await asyncio.wait_for(geolocator.get_geoposition_async(), timeout=10.0)
            if not pos:
                return {"error": "Windows Location Services returned no data."}

            return {
                "lat": pos.coordinate.point.position.latitude,
                "lon": pos.coordinate.point.position.longitude,
                "accuracy": pos.coordinate.accuracy
            }
        except asyncio.TimeoutError:
            return {"error": "Windows Geolocation request timed out."}
        except Exception as e:
            return {"error": f"WinRT API Error: {str(e)}"}

    try:
        try:
            geo_data = asyncio.run(fetch_windows_location())
        except RuntimeError:
            loop = asyncio.get_event_loop()
            geo_data = loop.run_until_complete(fetch_windows_location())

        if "error" in geo_data:
            return f"System Error retrieving location: {geo_data['error']}"

        lat = geo_data["lat"]
        lon = geo_data["lon"]
        accuracy = geo_data["accuracy"]

        api_key = os.getenv("GOOGLE_API_KEY")
        readable_address = "Unknown Location"

        if api_key:
            try:
                geocode_url = f"https://maps.googleapis.com/maps/api/geocode/json?latlng={lat},{lon}&key={api_key}"
                address_response = requests.get(geocode_url, timeout=5)
                address_data = address_response.json()
                if address_data.get("results"):
                    readable_address = address_data["results"][0]["formatted_address"]
            except Exception as geo_e:
                print(f"⚠️ [SYSTEM] Google Geocoding failed: {geo_e}")

        return f"Live Location: {readable_address} | Coordinates: {lat:.5f}, {lon:.5f} | Accuracy Radius: ~{accuracy:.1f} meters"
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
        level_str = str(level).strip()
        if level_str.startswith('+') or level_str.startswith('-'):
            delta = int(level_str)
            target_pct = current_brightness + delta
        else:
            target_pct = int(level_str)

        target_pct = max(0, min(100, target_pct))
        sbc.set_brightness(target_pct, display=0)

        return f"System brightness successfully changed from {current_brightness}% to {target_pct}%."
    except Exception as e:
        return f"System Error setting brightness: {str(e)}"


def set_system_volume(level: str) -> str:
    """Sets the Windows master volume to an absolute percentage or applies a relative change."""
    if not AudioUtilities:
        return "Error: 'pycaw' is not installed. Run 'pip install pycaw'."
    try:
        device = AudioUtilities.GetSpeakers()
        volume = device.EndpointVolume

        current_scalar = volume.GetMasterVolumeLevelScalar()
        current_pct = int(round(current_scalar * 100))

        level_str = str(level).strip()
        if level_str.startswith('+') or level_str.startswith('-'):
            delta = int(level_str)
            target_pct = current_pct + delta
        else:
            target_pct = int(level_str)

        target_pct = max(0, min(100, target_pct))
        volume.SetMasterVolumeLevelScalar(target_pct / 100.0, None)

        if target_pct > 0 and volume.GetMute():
            volume.SetMute(0, None)
        elif target_pct == 0:
            volume.SetMute(1, None)

        return f"System volume successfully changed from {current_pct}% to {target_pct}%."
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


def control_media_playback(command: str) -> str:
    """Controls the Windows media playback (play, pause, stop, next, previous)."""
    if not MediaManager:
        return "Error: Windows SDK media controls are not installed."

    async def _control(cmd):
        sessions = await MediaManager.request_async()
        current_session = sessions.get_current_session()
        if not current_session:
            return "Error: No active media session found to control."

        cmd = cmd.lower().strip()
        if cmd in ["play", "resume"]:
            await current_session.try_play_async()
            return "Media playback resumed."
        elif cmd in ["pause", "stop"]:
            await current_session.try_pause_async()
            return "Media playback paused."
        elif cmd in ["next", "skip"]:
            await current_session.try_skip_next_async()
            return "Skipped to the next track."
        elif cmd in ["previous", "back"]:
            await current_session.try_skip_previous_async()
            return "Returned to the previous track."
        else:
            return f"Error: Unrecognized media command '{cmd}'."

    try:
        try:
            return asyncio.run(_control(command))
        except RuntimeError:
            loop = asyncio.get_event_loop()
            return loop.run_until_complete(_control(command))
    except Exception as e:
        return f"System Error executing media command: {str(e)}"


# ---------------------------------------------------------
# 5. DESKTOP WINDOWS & SCREEN VISION
# ---------------------------------------------------------

def get_active_windows(**kwargs):
    """Scans the OS and returns a list of all visible desktop windows."""
    visible_windows = []
    raw_active_hwnd = win32gui.GetForegroundWindow()

    ignored_processes = [
        "nxdock.exe", "nexus.exe", "winstep.exe", "powertoys.exe",
        "powertoys.peek.ui.exe", "hpaudiocontrol.exe", "raycast.exe",
        "applicationframehost.exe", "textinputhost.exe", "searchhost.exe"
    ]

    ignored_titles = [
        "program manager", "settings", "microsoft text input application",
        "powertoys quick access", "windows input experience", "nxdock", "hp audio control"
    ]

    def enum_win_callback(hwnd, ctx):
        if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
            title = win32gui.GetWindowText(hwnd)
            title_lower = title.lower()
            if any(ext in title_lower for ext in ignored_titles):
                return

            rect = win32gui.GetWindowRect(hwnd)
            w = rect[2] - rect[0]
            h = rect[3] - rect[1]

            if w > 10 and h > 10:
                try:
                    _, pid = win32process.GetWindowThreadProcessId(hwnd)
                    proc = psutil.Process(pid)
                    app_name = proc.name().lower()
                except Exception:
                    app_name = "unknown.exe"

                if app_name in ignored_processes:
                    return

                visible_windows.append({
                    "hwnd": hwnd, "title": title, "app": app_name, "is_active": False
                })

    win32gui.EnumWindows(enum_win_callback, None)

    if not visible_windows:
        return "No visible windows found on the desktop."

    try:
        _, active_pid = win32process.GetWindowThreadProcessId(raw_active_hwnd)
        active_proc_name = psutil.Process(active_pid).name().lower()
    except Exception:
        active_proc_name = ""

    true_focus_index = 0
    if "python" in active_proc_name:
        for idx, w in enumerate(visible_windows):
            if "python" not in w["app"]:
                true_focus_index = idx
                break
    else:
        for idx, w in enumerate(visible_windows):
            if w["hwnd"] == raw_active_hwnd:
                true_focus_index = idx
                break

    if visible_windows:
        visible_windows[true_focus_index]["is_active"] = True

    output = "--- CURRENTLY OPEN WINDOWS ON SCREEN ---\n"
    for w in visible_windows:
        if "python" in w["app"] and not w["is_active"]:
            continue
        status = "[🟢 ACTIVE FOCUS]" if w["is_active"] else "[Background]"
        output += f"{status} {w['title']} (Process: {w['app']})\n"

    output += "\nSYSTEM NOTE: The [🟢 ACTIVE FOCUS] tag bypasses overlay windows to identify the application in active use."
    return output


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
        city_display = f"{loc.get('name', location)}, {loc.get('country_code', '')}".strip(
            ", ")

        forecast_url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            "&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code"
            "&hourly=temperature_2m,precipitation_probability,weather_code"
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
            "&timezone=auto"
        )
        data = requests.get(forecast_url, timeout=8.0).json()

        curr = data.get("current", {})
        cond_text, icon = WMO_MAP.get(
            curr.get("weather_code", 0), ("Unknown", "☁️"))
        current_temp = int(round(curr.get("temperature_2m", 0)))
        feels_like = int(round(curr.get("apparent_temperature", 0)))
        wind_speed = curr.get("wind_speed_10m", 0)

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

        return "\n".join(output)
    except Exception as e:
        return f"❌ Weather API Error: {str(e)}"


def open_in_browser(url: str) -> str:
    """Opens a given URL in the user's default system web browser."""
    clean_url = url.strip()
    if not clean_url.startswith(("http://", "https://")):
        clean_url = f"https://{clean_url}"

    try:
        print(f"\n🌐 [BROWSER] Opening URL: {clean_url}")
        success = webbrowser.open(clean_url)
        if success:
            return f"Successfully opened {clean_url} in your default browser."
        else:
            return f"Failed to launch web browser for {clean_url}."
    except Exception as e:
        return f"Error opening browser: {str(e)}"


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
# 19. EXPLANATORY MEDIA TOOL (ZERO API KEY / HIGH FIDELITY)
# ---------------------------------------------------------

def fetch_explanatory_media(query: str, additional_queries: list = None, count: int = 4) -> str:
    """
    Searches and retrieves visual illustrations, diagrams, landmarks, historical photos,
    or portraits to enhance an explanation from Wikipedia & Wikimedia Commons
    with zero API keys, no registration, and zero rate limit issues.
    Always returns exactly 4 high-resolution, verified images for a single row.
    """
    try:
        queries = [query.strip()]
        if additional_queries and isinstance(additional_queries, list):
            for q in additional_queries:
                if isinstance(q, str) and q.strip() and q.strip() not in queries:
                    queries.append(q.strip())

        headers = {
            "User-Agent": "AidenAssistant/1.0 (Desktop AI Companion; contact: support@aiden.ai)",
            "Accept": "application/json"
        }

        collected = []
        seen = set()

        def add_image(title, url, thumb, source="Wikipedia"):
            if not url or not thumb:
                return
            if not thumb.startswith("https://") or not url.startswith("https://"):
                return
            # Filter non-photo vector/audio/system files
            lower = thumb.lower()
            if any(ext in lower for ext in [".svg", ".tif", ".tiff", ".pdf", ".ogg", ".ogv", ".webm", ".ico"]):
                return
            if thumb in seen or url in seen:
                return
            seen.add(thumb)
            seen.add(url)
            collected.append({
                "title": title[:65],
                "url": url,
                "thumbnail": thumb,
                "source": source
            })

        for q in queries:
            if len(collected) >= 4:
                break

            # Priority 1: Wikipedia Pageimages (Directly connected to encyclopedic topics)
            try:
                wiki_url = "https://en.wikipedia.org/w/api.php"
                params = {
                    "action": "query",
                    "format": "json",
                    "generator": "search",
                    "gsrsearch": q,
                    "gsrlimit": 8,
                    "prop": "pageimages",
                    "piprop": "thumbnail|original",
                    "pithumbsize": 960
                }
                res = requests.get(wiki_url, params=params, headers=headers, timeout=5)
                if res.status_code == 200:
                    pages = res.json().get("query", {}).get("pages", {})
                    for page in pages.values():
                        thumb = page.get("thumbnail", {}).get("source")
                        orig = page.get("original", {}).get("source")
                        title = page.get("title", "")
                        if thumb:
                            add_image(title, orig or thumb, thumb, source="Wikipedia")
                        if len(collected) >= 4:
                            break
            except Exception:
                pass

            if len(collected) >= 4:
                break

            # Priority 2: Wikimedia Commons (High-res media repository)
            try:
                commons_url = "https://commons.wikimedia.org/w/api.php"
                params = {
                    "action": "query",
                    "format": "json",
                    "generator": "search",
                    "gsrsearch": q,
                    "gsrnamespace": "6",
                    "gsrlimit": 10,
                    "prop": "imageinfo",
                    "iiprop": "url|mime",
                    "iiurlwidth": 960
                }
                res = requests.get(commons_url, params=params, headers=headers, timeout=5)
                if res.status_code == 200:
                    pages = res.json().get("query", {}).get("pages", {})
                    for page in pages.values():
                        info = page.get("imageinfo", [{}])[0]
                        mime = info.get("mime", "")
                        if "image" not in mime or "svg" in mime or "tiff" in mime:
                            continue
                        thumb = info.get("thumburl") or info.get("url")
                        orig = info.get("url")
                        raw_title = page.get("title", "").replace("File:", "")
                        clean_title = raw_title.rsplit(".", 1)[0].replace("_", " ")
                        if len(clean_title) > 3 and not clean_title.lower().startswith("dsc_"):
                            add_image(clean_title, orig or thumb, thumb, source="Wikimedia Commons")
                        if len(collected) >= 4:
                            break
            except Exception:
                pass

        final_images = collected[:4]
        if not final_images:
            return json.dumps({
                "status": "not_found",
                "message": f"No relevant visual media found for '{query}'. Proceed explaining textually."
            })

        sample_items = [f"{img['thumbnail']} | {img['title']}" for img in final_images]
        sample_tag = "::media-gallery[" + ", ".join(sample_items) + "]::"

        return json.dumps({
            "status": "success",
            "count": len(final_images),
            "images": final_images,
            "instruction": (
                "Embed these 4 images into your explanation text at the exact position (start, middle between paragraphs, or end) "
                f"where this visual row is most contextually relevant using this exact tag format: {sample_tag}"
            )
        }, indent=2)

    except Exception as e:
        return f"Error fetching explanatory media: {str(e)}"


# ---------------------------------------------------------
# 20. GROUNDED WEB SEARCH TOOL (OPENAI REAL-TIME RESPONSES)
# ---------------------------------------------------------

def grounded_web_search(query: str, search_context: str = "medium") -> str:
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

        depth = search_context.lower() if search_context in ["low", "medium", "high"] else "medium"

        print(f"   [WEB SEARCH]: Querying live web via gpt-6-luna (Depth: {depth}): '{query}'")

        resp = client.responses.create(
            model="gpt-6-luna",
            input=(
                f"Search the live web thoroughly and provide verified, up-to-date facts, dates, context, and sources for:\n"
                f"\"{query}\"\n\n"
                f"Focus on accuracy, real-time developments, and concrete source attribution."
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
            "\n".join([f"• [{s['title']}]({s['url']})" for s in unique_sources])
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
    "grounded_web_search": grounded_web_search,
    "fetch_explanatory_media": fetch_explanatory_media,
    "get_system_telemetry": get_system_telemetry,
    "get_current_time_date": get_current_time_date,
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
    "control_media_playback": control_media_playback,
    "set_system_volume": set_system_volume,
    "open_in_browser": open_in_browser,
    "get_bible_passage": get_bible_passage
}
