"""
AIDEN YOUTUBE CORE TOOLS (ZERO-CONFIG PUBLIC ENDPOINT + OPTIONAL API KEY)
Direct YouTube video search & silent helpful-video suggestions with zero setup.
Uses YouTube's public InnerTube (`youtubei/v1/search`) endpoint with HTML
`ytInitialData` fallback and optional `YOUTUBE_API_KEY` Data API v3 override.

Mount cards automatically via per-turn thread-safe side-channel queue
(`::youtube-card[...]::`), keeping LLM replies concise and working memory clean.

AVAILABLE YOUTUBE TOOLS:
- search_youtube       (up to 4 videos -> 4-dot Hero Carousel Card)
- video_suggestion     (1 curated video -> Single Hero Video Card)
"""

import json
import os
import re
import threading
import urllib.parse
from typing import Any, Dict, List, Optional

import requests

_YOUTUBEI_URL = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false"
_YOUTUBE_RESULTS_URL = "https://www.youtube.com/results"
_YOUTUBE_API_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_YOUTUBE_VIDEO_FILTER_PARAM = "EgIQAQ=="  # Videos only (excludes channels/playlists)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_MAX_CARDS_PER_TURN = 2
_PENDING_LOCK = threading.Lock()
_PENDING_YOUTUBE_CARDS: List[Dict[str, Any]] = []


# ---------------------------------------------------------------------------
# Per-Turn Side-Channel Queue (Auto-Mounted onto stream_end in main.py)
# ---------------------------------------------------------------------------

def clear_pending_youtube_cards() -> None:
    """Clears any queued YouTube cards at the start of a new user turn."""
    with _PENDING_LOCK:
        _PENDING_YOUTUBE_CARDS.clear()


def enqueue_pending_youtube_card(payload: Dict[str, Any]) -> None:
    """Queues a validated YouTube card payload for automatic attachment at stream_end."""
    if not isinstance(payload, dict) or not payload.get("videos"):
        return
    with _PENDING_LOCK:
        if len(_PENDING_YOUTUBE_CARDS) >= _MAX_CARDS_PER_TURN:
            _PENDING_YOUTUBE_CARDS.pop(0)
        _PENDING_YOUTUBE_CARDS.append(payload)


def pop_pending_youtube_cards() -> List[Dict[str, Any]]:
    """Atomically pops and returns all queued YouTube cards for the current turn."""
    with _PENDING_LOCK:
        items = list(_PENDING_YOUTUBE_CARDS)
        _PENDING_YOUTUBE_CARDS.clear()
        return items


def serialize_youtube_card_tag(payload: Dict[str, Any]) -> str:
    """Serializes a YouTube card payload into a compact `::youtube-card[...]::` tag."""
    compact = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"::youtube-card[{compact}]::"


# ---------------------------------------------------------------------------
# Internal Parsing & Filtering Helpers
# ---------------------------------------------------------------------------

def _runs_to_text(node: Any) -> str:
    """Extracts plain text from YouTube simpleText or runs arrays."""
    if not isinstance(node, dict):
        return ""
    if isinstance(node.get("simpleText"), str):
        return node["simpleText"].strip()
    runs = node.get("runs")
    if isinstance(runs, list):
        return "".join(str(r.get("text", "")) for r in runs if isinstance(r, dict)).strip()
    return ""


def _parse_duration_seconds(dur_str: str) -> Optional[int]:
    """Parses '12:47' or '1:02:15' into total seconds. Returns None for LIVE/unknown."""
    if not dur_str:
        return None
    parts = dur_str.strip().split(":")
    if not (2 <= len(parts) <= 3):
        return None
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    return nums[0] * 3600 + nums[1] * 60 + nums[2]


def _extract_description(renderer: Dict[str, Any]) -> str:
    """Extracts a clean short description snippet from a videoRenderer node."""
    detailed = renderer.get("detailedMetadataSnippets")
    if isinstance(detailed, list) and detailed:
        first = detailed[0]
        if isinstance(first, dict):
            text = _runs_to_text(first.get("snippetText"))
            if text:
                return " ".join(text.split())[:220]
    desc = _runs_to_text(renderer.get("descriptionSnippet"))
    if desc:
        return " ".join(desc.split())[:220]
    return ""


def _walk_video_renderers(obj: Any, out: List[Dict[str, Any]], seen_ids: set) -> None:
    """Recursively extracts videoRenderer items from youtubei / ytInitialData JSON."""
    if len(out) >= 16:
        return
    if isinstance(obj, dict):
        if "videoRenderer" in obj and isinstance(obj["videoRenderer"], dict):
            v = obj["videoRenderer"]
            vid = str(v.get("videoId") or "").strip()
            if not vid or len(vid) != 11 or vid in seen_ids:
                return

            title = _runs_to_text(v.get("title"))
            if not title:
                return

            # Skip obvious Shorts URLs
            nav_url = (
                v.get("navigationEndpoint", {})
                .get("commandMetadata", {})
                .get("webCommandMetadata", {})
                .get("url", "")
            )
            if "/shorts/" in str(nav_url).lower():
                return

            channel = _runs_to_text(v.get("ownerText")) or _runs_to_text(v.get("longBylineText")) or "YouTube"
            duration = _runs_to_text(v.get("lengthText"))
            views = _runs_to_text(v.get("shortViewCountText")) or _runs_to_text(v.get("viewCountText"))
            published = _runs_to_text(v.get("publishedTimeText"))
            description = _extract_description(v)

            # Check live badges
            badges = v.get("badges") or []
            is_live = not duration
            for b in badges:
                label = str(b.get("metadataBadgeRenderer", {}).get("label", "")).upper()
                if "LIVE" in label:
                    is_live = True

            seen_ids.add(vid)
            out.append({
                "videoId": vid,
                "title": title,
                "channel": channel,
                "duration": duration or ("LIVE" if is_live else ""),
                "durationSec": _parse_duration_seconds(duration),
                "isLive": is_live,
                "views": views,
                "published": published,
                "description": description,
                "thumb": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "url": f"https://www.youtube.com/watch?v={vid}",
            })
            return
        for val in obj.values():
            _walk_video_renderers(val, out, seen_ids)
    elif isinstance(obj, list):
        for item in obj:
            _walk_video_renderers(item, out, seen_ids)


def _search_via_youtubei(query: str) -> List[Dict[str, Any]]:
    """Primary zero-config strategy: YouTube InnerTube public JSON search."""
    payload = {
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20241126.01.00",
                "hl": "en",
                "gl": "US",
            }
        },
        "query": query,
        "params": _YOUTUBE_VIDEO_FILTER_PARAM,
    }
    resp = requests.post(
        _YOUTUBEI_URL,
        json=payload,
        headers={
            "User-Agent": _USER_AGENT,
            "Content-Type": "application/json",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=9,
    )
    resp.raise_for_status()
    data = resp.json()
    found: List[Dict[str, Any]] = []
    _walk_video_renderers(data, found, set())
    return found


def _search_via_results_html(query: str) -> List[Dict[str, Any]]:
    """Secondary zero-config fallback: parse ytInitialData JSON from /results HTML."""
    resp = requests.get(
        _YOUTUBE_RESULTS_URL,
        params={"search_query": query, "sp": _YOUTUBE_VIDEO_FILTER_PARAM},
        headers={
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+417",
        },
        timeout=9,
    )
    resp.raise_for_status()
    text = resp.text
    marker = "var ytInitialData = "
    start = text.find(marker)
    if start == -1:
        marker = "ytInitialData = "
        start = text.find(marker)
    if start == -1:
        return []
    start += len(marker)
    end = text.find(";</script>", start)
    if end == -1:
        return []
    data = json.loads(text[start:end])
    found: List[Dict[str, Any]] = []
    _walk_video_renderers(data, found, set())
    return found


def _search_via_official_api(query: str, api_key: str, max_results: int = 8) -> List[Dict[str, Any]]:
    """Optional override when user supplies YOUTUBE_API_KEY in environment."""
    resp = requests.get(
        _YOUTUBE_API_SEARCH_URL,
        params={
            "part": "snippet",
            "q": query,
            "type": "video",
            "maxResults": max(4, min(10, max_results)),
            "key": api_key,
        },
        timeout=9,
    )
    resp.raise_for_status()
    data = resp.json()
    found: List[Dict[str, Any]] = []
    for item in data.get("items", []):
        vid = str(item.get("id", {}).get("videoId") or "").strip()
        if not vid:
            continue
        snip = item.get("snippet", {})
        thumbs = snip.get("thumbnails", {})
        thumb = (
            thumbs.get("high", {}).get("url")
            or thumbs.get("medium", {}).get("url")
            or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        )
        found.append({
            "videoId": vid,
            "title": str(snip.get("title") or "Untitled").strip(),
            "channel": str(snip.get("channelTitle") or "YouTube").strip(),
            "duration": "",
            "durationSec": None,
            "isLive": False,
            "views": "",
            "published": str(snip.get("publishedAt") or "")[:10],
            "description": " ".join(str(snip.get("description") or "").split())[:220],
            "thumb": thumb,
            "url": f"https://www.youtube.com/watch?v={vid}",
        })
    return found


def _fetch_youtube_candidates(query: str, prefer_non_shorts: bool = True) -> List[Dict[str, Any]]:
    """
    Fetches YouTube video candidates using optional YOUTUBE_API_KEY, otherwise
    zero-config InnerTube (`youtubei/v1/search`) with `/results` HTML fallback.
    """
    clean_query = " ".join((query or "").split()).strip()
    if not clean_query:
        return []

    raw: List[Dict[str, Any]] = []
    api_key = (os.getenv("YOUTUBE_API_KEY") or "").strip()
    if api_key:
        try:
            raw = _search_via_official_api(clean_query, api_key)
        except Exception as exc:
            print(f"⚠️ [YOUTUBE] Official API override failed, falling back to zero-config: {exc}")

    if not raw:
        try:
            raw = _search_via_youtubei(clean_query)
        except Exception as exc:
            print(f"⚠️ [YOUTUBE] InnerTube search failed, trying HTML fallback: {exc}")

    if not raw:
        try:
            raw = _search_via_results_html(clean_query)
        except Exception as exc:
            print(f"⚠️ [YOUTUBE] HTML fallback failed: {exc}")

    if not raw:
        return []

    if prefer_non_shorts:
        # Prefer full non-live videos (>= 60s), fall back to raw if everything is short
        filtered = [
            v for v in raw
            if not v.get("isLive")
            and (v.get("durationSec") is None or v["durationSec"] >= 60)
        ]
        if filtered:
            return filtered

    return raw


def _public_video_item(v: Dict[str, Any]) -> Dict[str, Any]:
    """Strips internal helper keys before serializing into the frontend UI payload."""
    return {
        "videoId": v["videoId"],
        "title": v["title"],
        "channel": v["channel"],
        "duration": v.get("duration") or "",
        "views": v.get("views") or "",
        "published": v.get("published") or "",
        "description": v.get("description") or "",
        "thumb": v["thumb"],
        "url": v["url"],
    }


# ---------------------------------------------------------------------------
# Public Core Tools
# ---------------------------------------------------------------------------

def search_youtube(query: str = "", max_results: int = 4, **kwargs) -> str:
    """
    Searches YouTube for up to 4 matching videos and queues the 4-dot Hero Carousel
    card to render automatically below AIDEN's concise response.
    """
    clean_query = " ".join((query or "").split()).strip()
    if not clean_query:
        return "Error: Please provide a non-empty search query for YouTube."

    try:
        limit = max(1, min(4, int(max_results)))
    except Exception:
        limit = 4

    print(f"\n▶️ [YOUTUBE] Searching YouTube for: '{clean_query}' (max={limit})...")
    candidates = _fetch_youtube_candidates(clean_query, prefer_non_shorts=True)
    if not candidates:
        return f"No YouTube videos could be retrieved right now for '{clean_query}'."

    picked = [_public_video_item(v) for v in candidates[:limit]]
    enqueue_pending_youtube_card({
        "mode": "search",
        "query": clean_query,
        "videos": picked,
    })

    lines = [
        f"[YOUTUBE HERO TRAY QUEUED AUTOMATICALLY - {len(picked)} video(s) for '{clean_query}']"
    ]
    for idx, v in enumerate(picked, start=1):
        meta = " · ".join(part for part in (v["channel"], v["duration"], v["views"]) if part)
        lines.append(f"{idx}. {v['title']} ({meta})")
    lines.append(
        "\nDIRECTIVE: The interactive YouTube Hero Card (with numbered dot switcher & Watch/Copy buttons) "
        "will mount automatically below your reply. Reply with ONE short, natural conversational sentence "
        "introducing the videos. Do NOT list URLs, recite all video titles, or write any `::youtube-card` tags."
    )
    return "\n".join(lines)


def video_suggestion(query: str = "", **kwargs) -> str:
    """
    Silently finds ONE high-relevance YouTube walkthrough/explainer video to tuck
    below AIDEN's explanation when a visual video genuinely elevates the answer.
    """
    clean_query = " ".join((query or "").split()).strip()
    if not clean_query:
        return "Error: Please provide a targeted topic query for video_suggestion."

    print(f"\n🎬 [YOUTUBE] Finding helpful walkthrough video for: '{clean_query}'...")
    candidates = _fetch_youtube_candidates(clean_query, prefer_non_shorts=True)
    if not candidates:
        return f"No suitable walkthrough video found for '{clean_query}'. Continue answering cleanly without mentioning a missing video."

    best = _public_video_item(candidates[0])
    enqueue_pending_youtube_card({
        "mode": "suggestion",
        "query": clean_query,
        "videos": [best],
    })

    meta = " · ".join(part for part in (best["channel"], best["duration"], best["views"]) if part)
    return (
        f"[HELPFUL VIDEO CARD QUEUED AUTOMATICALLY]\n"
        f"Selected: \"{best['title']}\" ({meta})\n\n"
        "DIRECTIVE: The single Hero Video Card will mount automatically below your explanation. "
        "Finish your helpful answer naturally and end with a brief casual pointer like "
        "'You can check the video down below for a visual walkthrough' (do NOT paste URLs or raw card tags)."
    )


# ---------------------------------------------------------------------------
# Tool Dispatch Map & Native OpenAI Responses API Schemas
# ---------------------------------------------------------------------------

YOUTUBE_TOOLS = {
    "search_youtube": search_youtube,
    "video_suggestion": video_suggestion,
}

YOUTUBE_TOOLS_SCHEMA = [
    {
        "type": "function",
        "name": "search_youtube",
        "description": (
            "Searches YouTube for up to 4 matching videos and automatically mounts an interactive "
            "4-dot Hero Video Carousel Card below your reply. Use this whenever the user explicitly "
            "asks to find, search, show, or watch YouTube videos on a topic. Always pass clean "
            "search keywords without conversational filler."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Clean YouTube search keywords (e.g. 'backpropagation explained visually', 'rust async tokio tutorial').",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Number of videos to include in the carousel (1 to 4, default 4).",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "video_suggestion",
        "description": (
            "Quietly fetches ONE relevant YouTube walkthrough or explainer video and mounts a "
            "clean Hero Video Card beneath your explanation. Call this selectively when answering "
            "conceptual learning questions, how-to tutorials, DIY/hardware guides, troubleshooting, "
            "or visual topics where a video genuinely deepens understanding — NEVER on casual "
            "small talk, simple factual lookups, or OS/email/calendar/Spotify tasks."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Targeted search keywords for a clear walkthrough or tutorial video on the topic being explained.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]
