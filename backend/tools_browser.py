"""
AIDEN INBUILT BROWSER TOOLS (Single-View Lightweight Browser)
Routes web URLs and browser-oriented opens (Gmail, Google Calendar, YouTube URLs, websites)
into AIDEN's native WebView2 child browser (960x600 Liquid-Glass morph), with optional
fallback to the external OS browser when explicitly requested.
"""

from __future__ import annotations

import webbrowser
from typing import Any, Dict
from urllib.parse import urlparse


def _broadcast(payload: Dict[str, Any]) -> bool:
    """Thread-safe WebSocket broadcast helper to the AIDEN UI pill."""
    try:
        import server  # type: ignore

        loop = getattr(server, "_server_loop", None)
        if loop is None or loop.is_closed():
            return False
        server.broadcast_event(payload)
        return True
    except Exception:
        try:
            from backend import server  # type: ignore

            loop = getattr(server, "_server_loop", None)
            if loop is None or loop.is_closed():
                return False
            server.broadcast_event(payload)
            return True
        except Exception as e:
            print(f"⚠️ [BROWSER] Broadcast failed: {e}")
            return False


def _normalize_web_url(url: str) -> str:
    clean = (url or "").strip()
    if not clean:
        raise ValueError("URL cannot be empty.")
    if "://" not in clean:
        clean = f"https://{clean}"
    parsed = urlparse(clean)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"Unsupported or invalid web URL: {clean}")
    return clean


def open_in_browser(url: str, mode: str = "inbuilt") -> str:
    """
    Opens a web URL in Aiden's single-view inbuilt browser by default (mode='inbuilt'),
    or launches the external OS default browser when mode='external'.
    """
    try:
        clean_url = _normalize_web_url(url)
    except ValueError as e:
        return f"Invalid URL: {e}"

    chosen_mode = (mode or "inbuilt").strip().lower()
    if chosen_mode in ("external", "system", "chrome", "edge", "default"):
        try:
            print(f"\n🌐 [BROWSER] Opening externally: {clean_url}")
            if webbrowser.open(clean_url):
                return f"Successfully opened {clean_url} in your external default browser."
            return f"Failed to launch external browser for {clean_url}."
        except Exception as e:
            return f"Error opening external browser: {str(e)}"

    print(f"\n🌐 [BROWSER] Opening in Aiden Browser (960x600): {clean_url}")
    if _broadcast({"type": "browser_open", "url": clean_url, "width": 960, "height": 600}):
        return (
            f"Opened {clean_url} inside Aiden Browser (960x600 single-view window). "
            "Clicking Return to chat destroys the browser session cleanly."
        )

    # Fallback if WS bridge is offline (CLI testing)
    try:
        webbrowser.open(clean_url)
        return f"Aiden UI bridge was offline, so {clean_url} opened in your default browser."
    except Exception as e:
        return f"Error opening browser: {str(e)}"


def browser_navigate(action: str, url: str = "") -> str:
    """Navigates inside the currently active Aiden Browser ('back', 'forward', 'reload', or 'goto')."""
    act = (action or "").strip().lower()
    if act not in ("back", "forward", "reload", "refresh", "goto", "navigate", "open"):
        return f"Unsupported browser navigation action '{action}'. Use 'back', 'forward', 'reload', or 'goto'."

    if act == "refresh":
        act = "reload"
    elif act in ("navigate", "open"):
        act = "goto"

    clean_url = ""
    if act == "goto":
        try:
            clean_url = _normalize_web_url(url)
        except ValueError as e:
            return f"Cannot navigate: {e}"

    _broadcast({"type": "browser_navigate", "action": act, "url": clean_url})
    if act == "goto":
        return f"Navigating Aiden Browser to {clean_url}."
    return f"Triggered '{act}' in Aiden Browser."


def browser_scroll(direction: str = "down", amount: str = "half") -> str:
    """Scrolls the active webpage inside Aiden Browser ('up', 'down', 'top', or 'bottom')."""
    dir_clean = (direction or "down").strip().lower()
    if dir_clean not in ("up", "down", "top", "bottom"):
        return f"Unsupported scroll direction '{direction}'. Use 'up', 'down', 'top', or 'bottom'."

    amt_clean = (amount or "half").strip().lower()
    if amt_clean not in ("small", "half", "page"):
        amt_clean = "half"

    _broadcast({"type": "browser_scroll", "direction": dir_clean, "amount": amt_clean})
    if dir_clean in ("top", "bottom"):
        return f"Scrolled Aiden Browser to the {dir_clean} of the page."
    return f"Scrolled Aiden Browser {dir_clean} ({amt_clean})."


def browser_close() -> str:
    """Closes and destroys Aiden Browser completely, returning AIDEN to chat mode."""
    _broadcast({"type": "browser_close"})
    return "Closed and destroyed Aiden Browser, returning to chat mode."


BROWSER_TOOLS = {
    "open_in_browser": open_in_browser,
    "browser_navigate": browser_navigate,
    "browser_scroll": browser_scroll,
    "browser_close": browser_close,
}
