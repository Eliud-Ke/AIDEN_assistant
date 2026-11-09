"""
AIDEN SPOTIFY CONNECTOR TOOLS
Direct integration with Spotify Web API.
Features zero external SDK bloat (pure Python requests).
Handles in-memory access token caching, silent refresh via Windows Credential Manager,
automatic background hot-loading of the Spotify client on Windows, and comprehensive
playback and library controls.
"""

import os
import sys
import time
import subprocess
from typing import Optional, Dict, Any, List

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
            "under Settings -> Authentication -> Spotify."
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


def get_or_resolve_device_id() -> Optional[str]:
    """
    Returns the currently active Spotify device ID.
    Queries Spotify to find the active player; if none is active, activates an idle device.
    """
    global _active_device_state

    # 1. Quick check against live Spotify player/devices
    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        res = requests.get(f"{SPOTIFY_API_BASE}/me/player/devices", headers=headers, timeout=4)
        if res.status_code == 200:
            devices = res.json().get("devices", [])
            active_dev = next((d for d in devices if d.get("is_active")), None)
            if active_dev:
                dev_id = active_dev["id"]
                _active_device_state = {
                    "device_id": dev_id,
                    "device_name": active_dev.get("name", "Active Device"),
                    "device_type": active_dev.get("type", "Speaker"),
                    "volume_percent": active_dev.get("volume_percent", 80),
                    "supports_volume": active_dev.get("supports_volume", True),
                    "updated_at": time.time(),
                }
                return dev_id
    except Exception:
        pass

    # 2. If no device is currently active, activate or wake up
    res = resolve_or_activate_device(timeout_seconds=8.0)
    return res.get("device_id") if res.get("ok") else None


# ---------------------------------------------------------------------------
# 1. Device Verification & Hot-Load
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
            return f"Spotify is active and ready on {dev_name} ({dev_type})."
        else:
            return res["message"]

    except Exception as e:
        return f"Error verifying Spotify devices: {str(e)}"


# ---------------------------------------------------------------------------
# 2. Catalog Search: Search Spotify Tracks, Albums, Artists & Playlists
# ---------------------------------------------------------------------------

def spotify_search(query: str, search_type: str = "track", limit: int = 5) -> str:
    """
    Searches the Spotify catalog for tracks, albums, artists, or playlists.
    Returns the top matching results with their titles, artists, and Spotify IDs.
    """
    if not query or not query.strip():
        return "Please specify a song title, artist, album, or playlist to search for."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}

        clean_type = search_type.strip().lower()
        if clean_type not in ["track", "album", "artist", "playlist"]:
            clean_type = "track"

        limit = max(1, min(10, int(limit)))
        clean_query = query.strip().strip('"\'')

        url = f"{SPOTIFY_API_BASE}/search"
        params = {
            "q": clean_query,
            "type": clean_type,
            "limit": limit,
            "market": "from_token"
        }

        res = requests.get(url, headers=headers, params=params, timeout=8)
        if res.status_code != 200:
            return f"Spotify search error ({res.status_code}): {res.text}"

        data = res.json()
        results_lines = []

        if clean_type == "track":
            tracks = data.get("tracks", {}).get("items", [])
            if not tracks:
                return f"No tracks found matching '{query}' on Spotify."
            for idx, trk in enumerate(tracks, 1):
                t_name = trk.get("name", "Unknown Track")
                artists = ", ".join(a.get("name", "") for a in trk.get("artists", []))
                album = trk.get("album", {}).get("name", "Unknown Album")
                dur_ms = trk.get("duration_ms", 0)
                dur_str = f"{dur_ms // 60000}:{(dur_ms % 60000) // 1000:02d}"
                t_id = trk.get("id", "")
                results_lines.append(f"{idx}. '{t_name}' by {artists} (Album: '{album}', {dur_str}) [ID: {t_id}]")

        elif clean_type == "album":
            albums = data.get("albums", {}).get("items", [])
            if not albums:
                return f"No albums found matching '{query}' on Spotify."
            for idx, alb in enumerate(albums, 1):
                a_name = alb.get("name", "Unknown Album")
                artists = ", ".join(a.get("name", "") for a in alb.get("artists", []))
                total_trks = alb.get("total_tracks", 0)
                rel_date = alb.get("release_date", "")[:4]
                a_id = alb.get("id", "")
                results_lines.append(f"{idx}. Album: '{a_name}' by {artists} ({total_trks} tracks, {rel_date}) [ID: {a_id}]")

        elif clean_type == "artist":
            artists = data.get("artists", {}).get("items", [])
            if not artists:
                return f"No artists found matching '{query}' on Spotify."
            for idx, art in enumerate(artists, 1):
                art_name = art.get("name", "Unknown Artist")
                genres = ", ".join(art.get("genres", [])[:2]) or "Music"
                art_id = art.get("id", "")
                results_lines.append(f"{idx}. Artist: {art_name} (Genres: {genres}) [ID: {art_id}]")

        elif clean_type == "playlist":
            playlists = data.get("playlists", {}).get("items", [])
            if not playlists:
                return f"No playlists found matching '{query}' on Spotify."
            for idx, pl in enumerate(playlists, 1):
                pl_name = pl.get("name", "Unknown Playlist")
                owner = pl.get("owner", {}).get("display_name", "Spotify")
                pl_id = pl.get("id", "")
                results_lines.append(f"{idx}. Playlist: '{pl_name}' by {owner} [ID: {pl_id}]")

        joined = "\n".join(results_lines)
        return f"Spotify Search Results for '{query}' ({clean_type}s):\n{joined}\n\nCall `spotify_play_item(spotify_id=ID, item_type='{clean_type}')` to start playing."

    except Exception as e:
        return f"Error executing Spotify search: {str(e)}"


# ---------------------------------------------------------------------------
# 3. Streaming: Play Specific Song, Album, or Playlist
# ---------------------------------------------------------------------------

def spotify_play_item(spotify_id: str, item_type: str = "track") -> str:
    """
    Plays a specific track, album, playlist, or artist on Spotify by its ID or URI.
    """
    if not spotify_id or not spotify_id.strip():
        return "Please provide a valid Spotify ID or URI to play."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        dev_id = get_or_resolve_device_id()
        device_param = f"?device_id={dev_id}" if dev_id else ""

        # Clean ID
        clean_id = spotify_id.strip()
        if "spotify:" in clean_id:
            parts = clean_id.split(":")
            if len(parts) >= 3:
                item_type = parts[1]
                clean_id = parts[2]

        clean_type = item_type.strip().lower()
        if clean_type == "track":
            # Spotify Desktop (Win32 standalone) frequently ignores isolated 'uris' arrays
            # when its local queue is idle. Providing its album 'context_uri' with track 'offset'
            # guarantees immediate audio playback and proper Windows SMTC metadata registration.
            try:
                t_res = requests.get(f"{SPOTIFY_API_BASE}/tracks/{clean_id}", headers=headers, timeout=5)
                if t_res.status_code == 200:
                    t_data = t_res.json()
                    alb_uri = t_data.get("album", {}).get("uri")
                    if alb_uri:
                        play_payload = {
                            "context_uri": alb_uri,
                            "offset": {"uri": f"spotify:track:{clean_id}"}
                        }
                    else:
                        play_payload = {"uris": [f"spotify:track:{clean_id}"]}
                else:
                    play_payload = {"uris": [f"spotify:track:{clean_id}"]}
            except Exception:
                play_payload = {"uris": [f"spotify:track:{clean_id}"]}

        elif clean_type in ["album", "playlist", "artist"]:
            play_payload = {"context_uri": f"spotify:{clean_type}:{clean_id}"}
        else:
            play_payload = {"uris": [f"spotify:track:{clean_id}"]}

        play_url = f"{SPOTIFY_API_BASE}/me/player/play{device_param}"
        res = requests.put(play_url, headers=headers, json=play_payload, timeout=8)

        if res.status_code in [200, 204]:
            dev_name = _active_device_state.get("device_name", "your device")
            return f"Playing on {dev_name}."

        # If device was asleep or disconnected, retry once
        if res.status_code == 404:
            res_wake = resolve_or_activate_device(timeout_seconds=6.0)
            if res_wake.get("ok"):
                new_id = res_wake.get("device_id")
                res2 = requests.put(f"{SPOTIFY_API_BASE}/me/player/play?device_id={new_id}", headers=headers, json=play_payload, timeout=8)
                if res2.status_code in [200, 204]:
                    return f"Playing on {res_wake.get('device_name', 'your device')}."

        if res.status_code == 403:
            return "Playback restricted on this device or Spotify Premium required for direct queue streaming."

        return f"Could not start Spotify playback ({res.status_code}): {res.text}"

    except Exception as e:
        return f"Error playing Spotify item: {str(e)}"

# ---------------------------------------------------------------------------
# 4. Playback Modes: Shuffle & Repeat
# ---------------------------------------------------------------------------

def spotify_set_playback_mode(shuffle: Optional[bool] = None, repeat_mode: Optional[str] = None) -> str:
    """
    Sets shuffle mode (True/False) or repeat mode ('track', 'context', or 'off') on Spotify.
    """
    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        dev_id = get_or_resolve_device_id()
        device_param = f"&device_id={dev_id}" if dev_id else ""

        results = []

        if shuffle is not None:
            s_val = "true" if shuffle else "false"
            res = requests.put(f"{SPOTIFY_API_BASE}/me/player/shuffle?state={s_val}{device_param}", headers=headers, timeout=6)
            if res.status_code in [200, 204]:
                results.append(f"Shuffle {'enabled' if shuffle else 'disabled'}")

        if repeat_mode is not None:
            rep_clean = repeat_mode.strip().lower()
            if rep_clean in ["track", "song", "one"]:
                state_val = "track"
            elif rep_clean in ["context", "album", "playlist", "all"]:
                state_val = "context"
            else:
                state_val = "off"

            res = requests.put(f"{SPOTIFY_API_BASE}/me/player/repeat?state={state_val}{device_param}", headers=headers, timeout=6)
            if res.status_code in [200, 204]:
                results.append(f"Repeat set to '{state_val}'")

        if results:
            return f"{', '.join(results)} on Spotify."

        return "No playback mode change was specified."

    except Exception as e:
        return f"Error setting playback mode: {str(e)}"


# ---------------------------------------------------------------------------
# 5. Library: Like & Unlike Current Track
# ---------------------------------------------------------------------------

def _get_current_playing_track_info():
    """Helper to fetch currently playing track ID, title, and artists from Spotify."""
    token = get_valid_token()
    headers = {"Authorization": f"Bearer {token}"}
    cur_res = requests.get(f"{SPOTIFY_API_BASE}/me/player/currently-playing", headers=headers, timeout=6)
    if cur_res.status_code != 200 or not cur_res.text:
        return None, None, None
    cur_data = cur_res.json()
    item = cur_data.get("item")
    if not item or not item.get("id"):
        return None, None, None
    track_id = item["id"]
    track_name = item.get("name", "Current track")
    artists = ", ".join(a.get("name", "") for a in item.get("artists", []))
    return track_id, track_name, artists


def spotify_like_track() -> str:
    """
    Saves ('likes') the currently playing track into the user's Liked Songs library on Spotify.
    """
    try:
        track_id, track_name, artists = _get_current_playing_track_info()
        if not track_id:
            return "No track is currently playing on Spotify to like."

        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        res = requests.put(f"{SPOTIFY_API_BASE}/me/tracks?ids={track_id}", headers=headers, timeout=6)
        if res.status_code in [200, 204]:
            return f"Saved '{track_name}' by {artists} to your Liked Songs."
        return f"Could not save track to Liked Songs ({res.status_code})."

    except Exception as e:
        return f"Error saving track to Liked Songs: {str(e)}"


def spotify_unlike_track() -> str:
    """
    Removes ('unlikes') the currently playing track from the user's Liked Songs library on Spotify.
    """
    try:
        track_id, track_name, artists = _get_current_playing_track_info()
        if not track_id:
            return "No track is currently playing on Spotify to unlike."

        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        res = requests.delete(f"{SPOTIFY_API_BASE}/me/tracks?ids={track_id}", headers=headers, timeout=6)
        if res.status_code in [200, 204]:
            return f"Removed '{track_name}' by {artists} from your Liked Songs."
        return f"Could not remove track from Liked Songs ({res.status_code})."

    except Exception as e:
        return f"Error removing track from Liked Songs: {str(e)}"


# ---------------------------------------------------------------------------
# Schema & Registry Exports
# ---------------------------------------------------------------------------

SPOTIFY_TOOLS = {
    "spotify_check_active_device": spotify_check_active_device,
    "spotify_search": spotify_search,
    "spotify_play_item": spotify_play_item,
    "spotify_set_playback_mode": spotify_set_playback_mode,
    "spotify_like_track": spotify_like_track,
    "spotify_unlike_track": spotify_unlike_track,
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
    },
    {
        "type": "function",
        "function": {
            "name": "spotify_search",
            "description": (
                "Searches the Spotify catalog for songs, albums, artists, or playlists. "
                "Use when the user wants to discover, browse, or find music."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Clean search keywords: song title, album, or artist name (e.g. 'Sexy For Me Jason Derulo', 'Talk Yeat', 'Find Me Sigma'). "
                            "Do NOT include conversational filler like 'play', 'music', 'search for', or prepositions like 'by' unless they are part of the song's actual title."
                        ),
                    },
                    "search_type": {
                        "type": "string",
                        "enum": ["track", "album", "artist", "playlist"],
                        "description": "Type of item to search for. Default is 'track'.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of results to return (1 to 10). Default is 5.",
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
            "name": "spotify_play_item",
            "description": (
                "Streams a specific track, album, playlist, or artist on Spotify using its ID or URI "
                "(obtained from `spotify_search` or direct request)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "spotify_id": {
                        "type": "string",
                        "description": "The Spotify ID or URI of the track, album, or playlist to stream.",
                    },
                    "item_type": {
                        "type": "string",
                        "enum": ["track", "album", "playlist", "artist"],
                        "description": "Type of item being played. Default is 'track'.",
                    },
                },
                "required": ["spotify_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spotify_set_playback_mode",
            "description": "Sets Spotify shuffle mode (on/off) or repeat mode ('track', 'context', or 'off').",
            "parameters": {
                "type": "object",
                "properties": {
                    "shuffle": {
                        "type": "boolean",
                        "description": "Enable (true) or disable (false) shuffle mode.",
                    },
                    "repeat_mode": {
                        "type": "string",
                        "enum": ["track", "context", "off"],
                        "description": "Repeat mode: 'track' to loop single song, 'context' to repeat album/playlist, 'off' to disable repeat.",
                    },
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spotify_like_track",
            "description": "Saves ('likes') the currently playing song into the user's Liked Songs library on Spotify.",
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
            "name": "spotify_unlike_track",
            "description": "Removes ('unlikes') the currently playing song from the user's Liked Songs library on Spotify.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
]
