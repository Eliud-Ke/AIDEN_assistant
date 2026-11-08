"""
AIDEN SPOTIFY CONNECTOR TOOLS
Direct integration with Spotify Web API.
Features zero external SDK bloat (pure Python requests).
Handles in-memory access token caching, silent refresh via Windows Credential Manager,
and automatic background hot-loading of the Spotify client on Windows.
"""

import os
import sys
import time
import subprocess
from typing import Optional, Dict, Any

import requests
from auth_manager import (
    get_spotify_access_token,
    get_spotify_status,
)

SPOTIFY_API_BASE = "https://api.spotify.com/v1"

# In-memory access token cache
_cached_access_token: Optional[str] = None
_token_expiry_timestamp: float = 0.0

# In-memory active device cache
_active_device_state: Dict[str, Any] = {
    "device_id": None,
    "device_name": None,
    "device_type": None,
    "volume_percent": None,
    "updated_at": 0.0,
}


# ---------------------------------------------------------------------------
# Auth & Token Helper
# ---------------------------------------------------------------------------

def get_valid_token(force_refresh: bool = False) -> str:
    """
    Returns a valid Spotify OAuth access token.
    Uses in-memory cache if token is still valid (>60s remaining),
    otherwise silently refreshes via auth_manager.
    """
    global _cached_access_token, _token_expiry_timestamp

    now = time.time()
    if not force_refresh and _cached_access_token and (now < _token_expiry_timestamp - 60):
        return _cached_access_token

    token = get_spotify_access_token()
    if not token:
        raise ValueError(
            "Spotify is not connected yet. Please click 'Connect with Spotify' "
            "in the bottom tray under Settings -> Authentication -> Spotify."
        )

    _cached_access_token = token
    # Spotify tokens are valid for 3600 seconds (1 hour)
    _token_expiry_timestamp = now + 3500
    return token


# ---------------------------------------------------------------------------
# Background Process Launcher (Minimized)
# ---------------------------------------------------------------------------

def launch_spotify_minimized() -> bool:
    """
    Launches the Spotify desktop app in minimized window style on Windows.
    Uses Spotify.exe --minimized if present, falling back to Start-Process spotify: -WindowStyle Minimized.
    """
    try:
        appdata = os.environ.get("APPDATA", "")
        spotify_exe = os.path.join(appdata, "Spotify", "Spotify.exe")
        
        if os.path.exists(spotify_exe):
            startupinfo = None
            if sys.platform == "win32":
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 6  # SW_MINIMIZE

            subprocess.Popen(
                [spotify_exe, "--minimized"],
                startupinfo=startupinfo,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False
            )
            print("🚀 [SPOTIFY HOT-LOAD] Launched Spotify.exe --minimized")
            return True

        # Fallback to Windows protocol handler
        cmd = 'Start-Process "spotify:" -WindowStyle Minimized'
        subprocess.Popen(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False
        )
        print("🚀 [SPOTIFY HOT-LOAD] Launched Start-Process spotify: -WindowStyle Minimized")
        return True

    except Exception as e:
        print(f"⚠️ [SPOTIFY HOT-LOAD] Failed to launch Spotify desktop client: {e}")
        return False


# ---------------------------------------------------------------------------
# Device Resolution & Hot-Load Engine
# ---------------------------------------------------------------------------

def resolve_or_activate_device(target_device: Optional[str] = None, timeout_seconds: float = 10.0) -> Dict[str, Any]:
    """
    Checks for available Spotify Connect devices. If none are active, automatically
    activates an idle device or launches Spotify minimized and polls for up to timeout_seconds.
    """
    global _active_device_state

    token = get_valid_token()
    headers = {"Authorization": f"Bearer {token}"}
    start_time = time.time()
    launched_process = False

    while True:
        try:
            res = requests.get(f"{SPOTIFY_API_BASE}/me/player/devices", headers=headers, timeout=6)
            if res.status_code == 401:
                # Token expired in flight, refresh and retry once
                token = get_valid_token(force_refresh=True)
                headers["Authorization"] = f"Bearer {token}"
                continue
            
            devices = res.json().get("devices", []) if res.status_code == 200 else []
        except Exception as ex:
            devices = []
            print(f"⚠️ [SPOTIFY DEVICE CHECK] Error querying devices: {ex}")

        # 1. Target device requested (e.g. 'phone', 'pc', 'laptop')
        if target_device:
            target_clean = target_device.strip().lower()
            matched = None
            for d in devices:
                d_name = d.get("name", "").lower()
                d_type = d.get("type", "").lower()
                if target_clean in d_name or target_clean in d_type:
                    matched = d
                    break

            if matched:
                dev_id = matched["id"]
                # If not currently active, transfer playback to activate it
                if not matched.get("is_active"):
                    try:
                        requests.put(
                            f"{SPOTIFY_API_BASE}/me/player",
                            headers=headers,
                            json={"device_ids": [dev_id], "play": False},
                            timeout=6
                        )
                    except Exception as e:
                        print(f"⚠️ [SPOTIFY TRANSFER] Notice transferring to {dev_id}: {e}")

                _active_device_state = {
                    "device_id": dev_id,
                    "device_name": matched.get("name", "Unknown Device"),
                    "device_type": matched.get("type", "Speaker"),
                    "volume_percent": matched.get("volume_percent", 80),
                    "updated_at": time.time(),
                }
                return {
                    "ok": True,
                    "device_id": dev_id,
                    "device_name": matched.get("name", "Unknown Device"),
                    "device_type": matched.get("type", "Speaker"),
                    "volume_percent": matched.get("volume_percent", 80),
                    "devices": devices,
                    "message": f"Successfully connected to target device: {matched.get('name')} ({matched.get('type')})."
                }

        # 2. No target specified - check if an active device is already playing or ready
        active_dev = next((d for d in devices if d.get("is_active")), None)
        if active_dev:
            dev_id = active_dev["id"]
            _active_device_state = {
                "device_id": dev_id,
                "device_name": active_dev.get("name", "Active Device"),
                "device_type": active_dev.get("type", "Speaker"),
                "volume_percent": active_dev.get("volume_percent", 80),
                "updated_at": time.time(),
            }
            return {
                "ok": True,
                "device_id": dev_id,
                "device_name": active_dev.get("name", "Active Device"),
                "device_type": active_dev.get("type", "Speaker"),
                "volume_percent": active_dev.get("volume_percent", 80),
                "devices": devices,
                "message": f"Spotify is active and ready on {active_dev.get('name')} ({active_dev.get('type')})."
            }

        # 3. Devices found, but none is active (e.g. PC or Phone is idle/asleep)
        if devices:
            # Prefer Computer / Laptop device, else first device
            chosen = next((d for d in devices if d.get("type", "").lower() == "computer"), devices[0])
            dev_id = chosen["id"]
            try:
                requests.put(
                    f"{SPOTIFY_API_BASE}/me/player",
                    headers=headers,
                    json={"device_ids": [dev_id], "play": False},
                    timeout=6
                )
            except Exception as e:
                print(f"⚠️ [SPOTIFY WAKE] Notice waking device {dev_id}: {e}")

            _active_device_state = {
                "device_id": dev_id,
                "device_name": chosen.get("name", "Connected Device"),
                "device_type": chosen.get("type", "Speaker"),
                "volume_percent": chosen.get("volume_percent", 80),
                "updated_at": time.time(),
            }
            return {
                "ok": True,
                "device_id": dev_id,
                "device_name": chosen.get("name", "Connected Device"),
                "device_type": chosen.get("type", "Speaker"),
                "volume_percent": chosen.get("volume_percent", 80),
                "devices": devices,
                "message": f"Activated standby device: {chosen.get('name')} ({chosen.get('type')}). Ready for playback."
            }

        # 4. Device list is completely empty -> Hot-load Spotify minimized once
        if not launched_process:
            launch_spotify_minimized()
            launched_process = True

        elapsed = time.time() - start_time
        if elapsed >= timeout_seconds:
            break

        time.sleep(1.2)

    return {
        "ok": False,
        "device_id": None,
        "device_name": None,
        "device_type": None,
        "volume_percent": None,
        "devices": [],
        "message": (
            "No active Spotify device was found after 10 seconds. "
            "Spotify was opened minimized in the background, but hasn't connected to Spotify Connect yet. "
            "Please ensure you are signed into your Spotify desktop app, or start Spotify on your phone."
        ),
    }


# ---------------------------------------------------------------------------
# The Primary Tool: spotify_check_active_device
# ---------------------------------------------------------------------------

def spotify_check_active_device(target_device: str = "") -> str:
    """
    Checks if a Spotify Connect playback device is active and ready.
    If no device is running, automatically launches Spotify minimized on Windows
    and waits up to 10 seconds for it to report in. Also supports transferring 
    to a specific device (e.g. target_device='phone' or 'laptop').
    """
    try:
        status = get_spotify_status()
        if not status.get("has_token"):
            return (
                "Spotify is not connected yet. Please click 'Connect with Spotify' "
                "under Settings -> Authentication to link your account."
            )

        res = resolve_or_activate_device(target_device=target_device or None, timeout_seconds=10.0)
        
        if res["ok"]:
            dev_name = res["device_name"]
            dev_type = res["device_type"]
            vol = res["volume_percent"]
            
            # Emit structured acrylic UI tile tag
            tile_tag = (
                f'::spotify-device[{{"name": "{dev_name}", "type": "{dev_type}", '
                f'"volume": {vol}, "is_active": true}}]::'
            )
            return f"Spotify is active and ready on **{dev_name}** ({dev_type}, Volume: {vol}%).\n\n{tile_tag}"
        else:
            return res["message"]

    except Exception as e:
        return f"Error verifying Spotify devices: {str(e)}"


# ---------------------------------------------------------------------------
# Schema & Registry Exports
# ---------------------------------------------------------------------------

SPOTIFY_TOOLS = {
    "spotify_check_active_device": spotify_check_active_device,
}

SPOTIFY_TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "spotify_check_active_device",
            "description": (
                "Verifies that an active Spotify playback device is ready for streaming. "
                "If no device is active, automatically launches the Spotify desktop client "
                "minimized in the background and waits up to 10 seconds for it to connect. "
                "Also used to transfer playback to a specific device (e.g. target_device='phone' or 'laptop')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "target_device": {
                        "type": "string",
                        "description": "Optional name or type of device to connect to (e.g. 'phone', 'laptop', 'desktop'). Leave empty for automatic resolution.",
                    }
                },
                "additionalProperties": False,
            },
        },
    }
]
