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
import json
import re
from difflib import SequenceMatcher
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
# 2. Catalog Search: Search Spotify Tracks, Artists & Albums (Discrete Tools)
# ---------------------------------------------------------------------------

def spotify_search_tracks(query: str, limit: int = 5) -> str:
    """
    Searches the Spotify catalog specifically for songs/tracks matching the query.
    Returns up to 5 top track results with title, artist, album, duration, artwork,
    Spotify ID, and an interactive visual card for immediate 1-tap playback.
    """
    if not query or not query.strip():
        return "Please specify a song title or artist name to search for."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        limit = max(1, min(5, int(limit)))
        clean_query = query.strip().strip('"\'')

        url = f"{SPOTIFY_API_BASE}/search"
        params = {
            "q": clean_query,
            "type": "track",
            "limit": limit,
            "market": "from_token"
        }

        res = requests.get(url, headers=headers, params=params, timeout=8)
        if res.status_code != 200:
            return f"Spotify track search error ({res.status_code}): {res.text}"

        data = res.json()
        tracks = data.get("tracks", {}).get("items", [])
        if not tracks:
            return f"No tracks found matching '{query}' on Spotify."

        results_lines = []
        track_items = []
        for idx, trk in enumerate(tracks[:5], 1):
            t_id = trk.get("id", "")
            t_name = trk.get("name", "Unknown Track")
            artists = ", ".join(a.get("name", "") for a in trk.get("artists", []))
            album_obj = trk.get("album", {}) or {}
            album = album_obj.get("name", "Unknown Album")
            imgs = album_obj.get("images", []) or []
            img_url = imgs[0].get("url", "") if imgs else ""
            dur_ms = trk.get("duration_ms", 0) or 0
            dur_str = f"{dur_ms // 60000}:{(dur_ms % 60000) // 1000:02d}"
            explicit = bool(trk.get("explicit", False))
            spotify_url = trk.get("external_urls", {}).get("spotify", f"https://open.spotify.com/track/{t_id}")

            track_items.append({
                "id": t_id,
                "name": t_name,
                "artists": artists,
                "album": album,
                "image": img_url,
                "duration": dur_str,
                "explicit": explicit,
                "spotifyUrl": spotify_url,
            })
            results_lines.append(f"{idx}. '{t_name}' by {artists} (Album: '{album}', {dur_str}) [ID: {t_id}]")

        card_payload = {
            "query": clean_query,
            "tracks": track_items,
        }
        card_tag = f"::spotify-tracks-card[{json.dumps(card_payload, ensure_ascii=False)}]::"

        joined = "\n".join(results_lines)
        return f"{card_tag}\n\nSpotify Track Results for '{query}':\n{joined}\n\nCall `spotify_play_item(spotify_id=ID, item_type='track')` to start playing."

    except Exception as e:
        return f"Error executing Spotify track search: {str(e)}"


def spotify_search_artists(query: str) -> str:
    """
    Searches the Spotify catalog specifically for music artists matching the query.
    Returns the primary artist profile with verified status, follower count, genres,
    Spotify ID, and an interactive minimal visual card for immediate 1-tap playback.
    """
    if not query or not query.strip():
        return "Please specify an artist name to search for."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        clean_query = query.strip().strip('"\'')

        # 1. Search for top 3 matching artists
        url = f"{SPOTIFY_API_BASE}/search"
        params = {
            "q": clean_query,
            "type": "artist",
            "limit": 3,
            "market": "from_token"
        }

        res = requests.get(url, headers=headers, params=params, timeout=8)
        if res.status_code != 200:
            return f"Spotify artist search error ({res.status_code}): {res.text}"

        data = res.json()
        artists = data.get("artists", {}).get("items", [])
        if not artists:
            return f"No artists found matching '{query}' on Spotify."

        primary_artist = artists[0]
        artist_id = primary_artist.get("id", "")
        artist_name = primary_artist.get("name", "Unknown Artist")
        popularity = primary_artist.get("popularity", 0)

        # High-res artist cover / profile image
        artist_imgs = primary_artist.get("images", [])
        artist_img = artist_imgs[0].get("url", "") if artist_imgs else ""

        # Web URL
        spotify_url = primary_artist.get("external_urls", {}).get("spotify", f"https://open.spotify.com/artist/{artist_id}")

        # 2. Enrich with exact Monthly Listeners & Real Genre
        listeners_label = "Popular on Spotify"
        try:
            ssr_res = requests.get(
                f"https://open.spotify.com/artist/{artist_id}",
                headers={"User-Agent": "facebookexternalhit/1.1"},
                timeout=3
            )
            if ssr_res.status_code == 200:
                html = ssr_res.text
                m_desc = re.search(r'<meta property="og:description" content="([^"]+)"', html)
                if m_desc:
                    m_listen = re.search(r'([0-9,.]+[KMkm]?\s+monthly listeners)', m_desc.group(1), re.IGNORECASE)
                    if m_listen:
                        listeners_label = m_listen.group(1).strip()
                if not artist_img:
                    m_img = re.search(r'<meta property="og:image" content="([^"]+)"', html)
                    if m_img:
                        artist_img = m_img.group(1).strip()
        except Exception:
            pass

        # Extract primary music genre from iTunes Free Search API
        primary_genre = "Music"
        try:
            it_res = requests.get(
                "https://itunes.apple.com/search",
                params={"term": artist_name, "entity": "musicArtist", "limit": 1},
                timeout=3
            )
            if it_res.status_code == 200:
                results = it_res.json().get("results", [])
                if results and results[0].get("primaryGenreName"):
                    primary_genre = results[0]["primaryGenreName"]
        except Exception:
            pass

        # 3. Build Minimal Visual Card Payload
        card_payload = {
            "artistId": artist_id,
            "name": artist_name,
            "image": artist_img,
            "verified": True,
            "monthlyListeners": listeners_label,
            "followers": listeners_label,
            "genres": primary_genre,
            "popularity": popularity,
            "spotifyUrl": spotify_url,
        }
        card_tag = f"::spotify-artist-card[{json.dumps(card_payload, ensure_ascii=False)}]::"

        # 4. Alternates (if any)
        alternates = []
        for alt in artists[1:3]:
            alt_name = alt.get("name", "")
            alt_id = alt.get("id", "")
            if alt_name:
                alternates.append(f"{alt_name} [ID: {alt_id}]")

        # 5. Compile output text
        output_parts = [
            f"Spotify Artist: {artist_name} [Artist ID: {artist_id}]",
            f"Monthly Listeners: {listeners_label} | Genre: {primary_genre}",
        ]
        if alternates:
            output_parts.append(f"Other matches: {', '.join(alternates)}")
        output_parts.append(f"To play: Call `spotify_play_item(spotify_id='{artist_id}', item_type='artist')` to stream artist radio.")

        return f"{card_tag}\n\n" + "\n".join(output_parts)

    except Exception as e:
        return f"Error executing Spotify artist search: {str(e)}"


def spotify_search_albums(query: str, limit: int = 5) -> str:
    """
    Searches the Spotify catalog specifically for albums matching the query.
    Returns up to 5 top matching albums with title, artist, track count, release year,
    cover artwork, Spotify ID, and an interactive visual card for immediate 1-tap playback.
    """
    if not query or not query.strip():
        return "Please specify an album name or artist to search for."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        limit = max(1, min(5, int(limit)))
        clean_query = query.strip().strip('"\'')

        url = f"{SPOTIFY_API_BASE}/search"
        params = {
            "q": clean_query,
            "type": "album",
            "limit": limit,
            "market": "from_token"
        }

        res = requests.get(url, headers=headers, params=params, timeout=8)
        if res.status_code != 200:
            return f"Spotify album search error ({res.status_code}): {res.text}"

        data = res.json()
        albums = data.get("albums", {}).get("items", [])
        if not albums:
            return f"No albums found matching '{query}' on Spotify."

        results_lines = []
        album_items = []
        for idx, alb in enumerate(albums[:5], 1):
            a_id = alb.get("id", "")
            a_name = alb.get("name", "Unknown Album")
            artists = ", ".join(a.get("name", "") for a in alb.get("artists", []))
            total_trks = int(alb.get("total_tracks", 0) or 0)
            rel_date = str(alb.get("release_date", ""))[:4]
            imgs = alb.get("images", []) or []
            img_url = imgs[0].get("url", "") if imgs else ""
            spotify_url = alb.get("external_urls", {}).get("spotify", f"https://open.spotify.com/album/{a_id}")

            album_items.append({
                "id": a_id,
                "name": a_name,
                "artists": artists,
                "totalTracks": total_trks,
                "year": rel_date,
                "image": img_url,
                "spotifyUrl": spotify_url,
            })
            results_lines.append(f"{idx}. Album: '{a_name}' by {artists} ({total_trks} tracks, {rel_date}) [ID: {a_id}]")

        card_payload = {
            "query": clean_query,
            "albums": album_items,
        }
        card_tag = f"::spotify-albums-card[{json.dumps(card_payload, ensure_ascii=False)}]::"

        joined = "\n".join(results_lines)
        return f"{card_tag}\n\nSpotify Album Results for '{query}':\n{joined}\n\nCall `spotify_play_item(spotify_id=ID, item_type='album')` to stream this album."

    except Exception as e:
        return f"Error executing Spotify album search: {str(e)}"


def _format_playlist_item(pl: Dict[str, Any], current_user_id: Optional[str] = None) -> Dict[str, Any]:
    """Normalizes a Spotify playlist object into AIDEN's card & text payload shape."""
    p_id = pl.get("id", "")
    p_name = pl.get("name", "Unknown Playlist")
    owner_obj = pl.get("owner") or {}
    owner_id = owner_obj.get("id")
    owner_name = owner_obj.get("display_name") or owner_id or "Spotify"
    tracks_obj = pl.get("tracks") or pl.get("items") or {}
    total_trks = int(tracks_obj.get("total", 0) or 0)
    imgs = pl.get("images") or []
    img_url = imgs[0].get("url", "") if imgs else ""
    spotify_url = (pl.get("external_urls") or {}).get(
        "spotify", f"https://open.spotify.com/playlist/{p_id}"
    )

    item: Dict[str, Any] = {
        "id": p_id,
        "name": p_name,
        "owner": owner_name,
        "totalTracks": total_trks,
        "image": img_url,
        "spotifyUrl": spotify_url,
    }
    if current_user_id is not None:
        item["isOwner"] = bool(owner_id and owner_id == current_user_id)
    return item


def _fetch_current_user_id(headers: Dict[str, str]) -> Optional[str]:
    """Best-effort lookup of the signed-in Spotify user's ID for ownership labeling."""
    try:
        res = requests.get(f"{SPOTIFY_API_BASE}/me", headers=headers, timeout=4)
        if res.status_code == 200:
            return res.json().get("id")
    except Exception:
        pass
    return None


def _fetch_user_library_playlists(
    headers: Dict[str, str], max_items: int = 100
) -> tuple[List[Dict[str, Any]], int, Optional[str]]:
    """
    Fetches the authenticated user's saved & created playlists via GET /me/playlists.
    Returns (formatted_items, library_total, error_message).
    """
    current_user_id = _fetch_current_user_id(headers)
    collected: List[Dict[str, Any]] = []
    offset = 0
    library_total = 0

    while len(collected) < max_items:
        page_limit = min(50, max_items - len(collected))
        res = requests.get(
            f"{SPOTIFY_API_BASE}/me/playlists",
            headers=headers,
            params={"limit": page_limit, "offset": offset},
            timeout=8,
        )
        if res.status_code != 200:
            return [], 0, f"Spotify library playlists error ({res.status_code}): {res.text}"

        data = res.json()
        library_total = int(data.get("total", library_total) or 0)
        raw_items = data.get("items", []) or []
        valid_page = [p for p in raw_items if isinstance(p, dict) and p.get("id")]
        for pl in valid_page:
            collected.append(_format_playlist_item(pl, current_user_id=current_user_id))

        if not data.get("next") or not raw_items:
            break
        offset += len(raw_items)

    return collected, max(library_total, len(collected)), None


def _score_library_playlist_match(query: str, playlist: Dict[str, Any]) -> float:
    """Scores how well a library playlist name matches the user's partial or exact query."""
    q_low = " ".join(query.lower().split())
    name_low = " ".join(str(playlist.get("name", "")).lower().split())
    if not q_low or not name_low:
        return 0.0
    if name_low == q_low:
        return 100.0
    if name_low.startswith(q_low):
        return 90.0
    if q_low in name_low:
        return 80.0

    q_tokens = [t for t in re.findall(r"[a-z0-9]+", q_low) if t]
    name_tokens = [t for t in re.findall(r"[a-z0-9]+", name_low) if t]
    token_hits = sum(1 for qt in q_tokens if any(qt in nt or nt in qt for nt in name_tokens))
    token_score = (token_hits / len(q_tokens)) * 65.0 if q_tokens else 0.0
    fuzzy_whole = SequenceMatcher(None, q_low, name_low).ratio() * 50.0
    fuzzy_word = max((SequenceMatcher(None, q_low, nt).ratio() * 55.0 for nt in name_tokens), default=0.0)
    return max(token_score, fuzzy_whole, fuzzy_word)


def spotify_search_playlists(query: str, limit: int = 5) -> str:
    """
    Searches Spotify's public catalog for playlists matching the query.
    Returns up to 5 top matching playlists with title, owner, track count,
    cover artwork, Spotify ID, and an interactive visual card for immediate 1-tap shuffle playback.
    """
    if not query or not query.strip():
        return "Please specify a playlist name, mood, or vibe to search for."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        limit = max(1, min(5, int(limit)))
        clean_query = query.strip().strip('"\'')

        # Fetch a small buffer because Spotify frequently injects null entries into playlist search results
        fetch_limit = min(10, limit + 3)
        url = f"{SPOTIFY_API_BASE}/search"
        params = {
            "q": clean_query,
            "type": "playlist",
            "limit": fetch_limit,
            "market": "from_token",
        }

        res = requests.get(url, headers=headers, params=params, timeout=8)
        if res.status_code != 200:
            return f"Spotify playlist search error ({res.status_code}): {res.text}"

        data = res.json()
        raw_items = data.get("playlists", {}).get("items", []) or []
        playlists = [p for p in raw_items if isinstance(p, dict) and p.get("id")][:limit]
        if not playlists:
            return f"No playlists found matching '{query}' on Spotify."

        results_lines = []
        playlist_items = []
        for idx, pl in enumerate(playlists, 1):
            item = _format_playlist_item(pl)
            playlist_items.append(item)
            results_lines.append(
                f"{idx}. Playlist: '{item['name']}' by {item['owner']} ({item['totalTracks']} tracks) [ID: {item['id']}]"
            )

        card_payload = {
            "query": clean_query,
            "playlists": playlist_items,
        }
        card_tag = f"::spotify-playlists-card[{json.dumps(card_payload, ensure_ascii=False)}]::"

        joined = "\n".join(results_lines)
        return (
            f"{card_tag}\n\nSpotify Playlist Results for '{query}':\n{joined}\n\n"
            "Call `spotify_play_playlist(playlist_id=ID)` to start a playlist (shuffle enabled by default)."
        )

    except Exception as e:
        return f"Error executing Spotify playlist search: {str(e)}"


def spotify_search_my_playlists(query: str) -> str:
    """
    Searches the user's own Spotify library (created & saved playlists) for a playlist name.
    Promotes the closest match as the primary card hero while keeping the rest of the user's
    playlists scrollable underneath.
    """
    if not query or not query.strip():
        return "Please specify the playlist name to look for in your Spotify library."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        clean_query = query.strip().strip('"\'')

        items, _, err = _fetch_user_library_playlists(headers, max_items=100)
        if err:
            return err
        if not items:
            return "You don't have any saved or created playlists in your Spotify library yet."

        # Rank all library playlists so the best match becomes #1 and the remaining library
        # playlists appear underneath even if their names don't match the query.
        scored = [
            (_score_library_playlist_match(clean_query, pl), -idx, pl)
            for idx, pl in enumerate(items)
        ]
        scored.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
        ordered = [entry[2] for entry in scored[:30]]
        top_score = scored[0][0]

        card_payload = {
            "mode": "search",
            "query": clean_query,
            "playlists": ordered,
        }
        card_tag = f"::spotify-library-playlists-card[{json.dumps(card_payload, ensure_ascii=False)}]::"

        results_lines = []
        for idx, item in enumerate(ordered[:10], 1):
            role = "Made by you" if item.get("isOwner") else f"Saved • By {item['owner']}"
            results_lines.append(
                f"{idx}. '{item['name']}' ({role}, {item['totalTracks']} tracks) [ID: {item['id']}]"
            )

        match_note = (
            f"Best library match for '{query}': '{ordered[0]['name']}'"
            if top_score >= 30.0
            else f"No close exact name match for '{query}' in your library; closest playlist shown first alongside your library:"
        )
        return (
            f"{card_tag}\n\n{match_note}\n"
            + "\n".join(results_lines)
            + "\n\nCall `spotify_play_playlist(playlist_id=ID)` to start playing any of these playlists (shuffle enabled by default)."
        )

    except Exception as e:
        return f"Error searching your Spotify playlists: {str(e)}"


def spotify_list_my_playlists(limit: int = 50) -> str:
    """
    Lists all playlists saved or created in the user's personal Spotify library.
    Renders a clean scrollable list card without a primary hero highlight.
    """
    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        capped_limit = max(1, min(100, int(limit)))

        items, library_total, err = _fetch_user_library_playlists(headers, max_items=capped_limit)
        if err:
            return err
        if not items:
            return "You don't have any saved or created playlists in your Spotify library yet."

        card_payload = {
            "mode": "list",
            "total": library_total,
            "playlists": items,
        }
        card_tag = f"::spotify-library-playlists-card[{json.dumps(card_payload, ensure_ascii=False)}]::"

        results_lines = []
        for idx, item in enumerate(items, 1):
            role = "Made by you" if item.get("isOwner") else f"Saved • By {item['owner']}"
            results_lines.append(
                f"{idx}. '{item['name']}' ({role}, {item['totalTracks']} tracks) [ID: {item['id']}]"
            )

        return (
            f"{card_tag}\n\nYour Spotify Library Playlists ({library_total} total, showing {len(items)}):\n"
            + "\n".join(results_lines)
            + "\n\nCall `spotify_play_playlist(playlist_id=ID)` to start any playlist (shuffle enabled by default)."
        )

    except Exception as e:
        return f"Error listing your Spotify playlists: {str(e)}"


# 3. Streaming: Play Specific Song, Album, or Playlist
# ---------------------------------------------------------------------------

def _parse_spotify_id_and_type(raw_id: str, default_type: str) -> tuple[str, str]:
    """Extracts clean Spotify ID and normalized item type from an ID, URI, or open.spotify.com URL."""
    clean_id = raw_id.strip()
    resolved_type = default_type.strip().lower()
    if "open.spotify.com/" in clean_id:
        path_part = clean_id.split("open.spotify.com/", 1)[1].split("?", 1)[0].strip("/")
        segments = [seg for seg in path_part.split("/") if seg]
        if len(segments) >= 2:
            resolved_type = segments[-2].lower()
            clean_id = segments[-1]
    elif "spotify:" in clean_id:
        parts = clean_id.split(":")
        if len(parts) >= 3:
            resolved_type = parts[1].lower()
            clean_id = parts[2]
    return clean_id, resolved_type


def _set_spotify_shuffle(headers: dict, state: bool, dev_id: Optional[str] = None) -> bool:
    """Applies Spotify shuffle mode on the target or active device."""
    s_val = "true" if state else "false"
    device_param = f"&device_id={dev_id}" if dev_id else ""
    try:
        res = requests.put(
            f"{SPOTIFY_API_BASE}/me/player/shuffle?state={s_val}{device_param}",
            headers=headers,
            timeout=6,
        )
        return res.status_code in [200, 204]
    except Exception:
        return False


def _execute_spotify_play(headers: dict, dev_id: Optional[str], play_payload: dict) -> tuple[bool, Optional[str], str]:
    """Starts Spotify playback and wakes an inactive device once on 404."""
    device_param = f"?device_id={dev_id}" if dev_id else ""
    play_url = f"{SPOTIFY_API_BASE}/me/player/play{device_param}"
    res = requests.put(play_url, headers=headers, json=play_payload, timeout=8)

    if res.status_code in [200, 204]:
        dev_name = _active_device_state.get("device_name", "your device")
        return True, dev_id, f"Playing on {dev_name}."

    # If device was asleep or disconnected, retry once
    if res.status_code == 404:
        res_wake = resolve_or_activate_device(timeout_seconds=6.0)
        if res_wake.get("ok"):
            new_id = res_wake.get("device_id")
            res2 = requests.put(
                f"{SPOTIFY_API_BASE}/me/player/play?device_id={new_id}",
                headers=headers,
                json=play_payload,
                timeout=8,
            )
            if res2.status_code in [200, 204]:
                return True, new_id, f"Playing on {res_wake.get('device_name', 'your device')}."
            res = res2

    if res.status_code == 403:
        return False, dev_id, "Playback restricted on this device or Spotify Premium required for direct queue streaming."

    return False, dev_id, f"Could not start Spotify playback ({res.status_code}): {res.text}"


def spotify_play_playlist(playlist_id: str) -> str:
    """
    Starts playing a Spotify playlist by its ID, URI, or URL with shuffle enabled by default.
    """
    if not playlist_id or not playlist_id.strip():
        return "Please provide a valid Spotify playlist ID or URI to play."

    try:
        token = get_valid_token()
        headers = {"Authorization": f"Bearer {token}"}
        dev_id = get_or_resolve_device_id()

        clean_id, _ = _parse_spotify_id_and_type(playlist_id, "playlist")
        play_payload = {"context_uri": f"spotify:playlist:{clean_id}"}

        # Enable shuffle before playback when a device is already awake so track 1 is randomized;
        # otherwise re-apply immediately after playback wakes the device.
        shuffle_applied = bool(dev_id) and _set_spotify_shuffle(headers, True, dev_id)
        ok, used_dev_id, status_msg = _execute_spotify_play(headers, dev_id, play_payload)
        if not ok:
            return status_msg

        if not shuffle_applied:
            shuffle_applied = _set_spotify_shuffle(headers, True, used_dev_id)

        if shuffle_applied:
            return f"{status_msg} Shuffle is enabled."
        return f"{status_msg} (Note: could not confirm shuffle state automatically.)"

    except Exception as e:
        return f"Error playing Spotify playlist: {str(e)}"


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

        clean_id, clean_type = _parse_spotify_id_and_type(spotify_id, item_type)
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

        _, _, status_msg = _execute_spotify_play(headers, dev_id, play_payload)
        return status_msg

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
            if _set_spotify_shuffle(headers, shuffle, dev_id):
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
    "spotify_search_tracks": spotify_search_tracks,
    "spotify_search_artists": spotify_search_artists,
    "spotify_search_albums": spotify_search_albums,
    "spotify_search_playlists": spotify_search_playlists,
    "spotify_search_my_playlists": spotify_search_my_playlists,
    "spotify_list_my_playlists": spotify_list_my_playlists,
    "spotify_play_playlist": spotify_play_playlist,
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
            "name": "spotify_search_tracks",
            "description": (
                "Searches Spotify specifically for songs/tracks matching the query. "
                "Returns up to 5 top track results with an interactive visual track card (::spotify-tracks-card[...]::), "
                "song title, artist, album, duration, and Spotify ID."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Clean search keywords: song title, or song title + artist name (e.g. 'Starboy', 'Sexy For Me Jason Derulo', 'Talk Yeat'). "
                            "Do NOT include conversational filler like 'play', 'music', 'search for', or prepositions like 'by' unless they are part of the song's actual title."
                        ),
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of tracks to return (1 to 5). Default is 5.",
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
            "name": "spotify_search_artists",
            "description": (
                "Searches Spotify for a music artist. Returns a minimal interactive visual artist card "
                "(::spotify-artist-card[...]::) with their verified profile, monthly listeners, primary genre, and Spotify ID."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Clean artist name (e.g. 'Yeat', 'The Weeknd', 'Kendrick Lamar', 'Travis Scott'). "
                            "Do NOT include conversational filler like 'who is', 'artist', 'musician', or 'search for'."
                        ),
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
            "name": "spotify_search_albums",
            "description": (
                "Searches Spotify specifically for music albums matching the query. "
                "Returns up to 5 top matching albums with an interactive visual album card (::spotify-albums-card[...]::), "
                "album title, artist, total tracks, release year, and Spotify ID."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Clean album name or album + artist name (e.g. 'After Hours', 'DAMN', 'Discovery Daft Punk'). "
                            "Do NOT include conversational filler like 'album', 'listen to', or 'search for'."
                        ),
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of albums to return (1 to 5). Default is 5.",
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
            "name": "spotify_search_playlists",
            "description": (
                "Searches Spotify's public catalog specifically for playlists matching the query "
                "(NOT the user's personal saved library). Returns up to 5 top matching playlists with "
                "an interactive visual playlist card (::spotify-playlists-card[...]::) and Spotify playlist IDs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Clean playlist name, mood, activity, or genre keywords (e.g. 'late night chill', "
                            "'Today\\'s Top Hits', 'workout hype'). Do NOT include conversational filler like 'search for' or 'on spotify'."
                        ),
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of playlists to return (1 to 5). Default is 5.",
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
            "name": "spotify_search_my_playlists",
            "description": (
                "Searches ONLY the user's personal Spotify library (playlists they created or saved) "
                "for a playlist name they know or partly remember. Returns an interactive visual card "
                "(::spotify-library-playlists-card[...]::) with the best match featured at the top and "
                "the rest of their library playlists listed underneath."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Name or partial keywords of the user's saved/created playlist "
                            "(e.g. 'gym', 'late night drive', 'chill vibes'). Do NOT include filler like 'my playlist' or 'search'."
                        ),
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
            "name": "spotify_list_my_playlists",
            "description": (
                "Lists all saved and created playlists in the user's personal Spotify library when they "
                "want to browse or don't know the exact playlist name. Returns a scrollable list visual card "
                "(::spotify-library-playlists-card[...]::)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of playlists to return (1 to 100). Default is 50.",
                    },
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spotify_play_playlist",
            "description": (
                "Dedicated tool for starting playback of a Spotify playlist using its ID, URI, or URL "
                "(obtained from `spotify_search_playlists`, `spotify_search_my_playlists`, `spotify_list_my_playlists`, or direct request). "
                "Automatically enables shuffle by default. Always prefer this tool over `spotify_play_item` when playing a playlist."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "playlist_id": {
                        "type": "string",
                        "description": "The Spotify playlist ID, URI, or URL to start playing.",
                    },
                },
                "required": ["playlist_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spotify_play_item",
            "description": (
                "Streams a specific track, album, or artist on Spotify using its ID or URI "
                "(obtained from `spotify_search_tracks`, `spotify_search_albums`, `spotify_search_artists`, or direct request). "
                "For playlists, prefer `spotify_play_playlist` (playlist type kept here only as fallback)."
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
