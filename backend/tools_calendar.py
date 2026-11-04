b"""
AIDEN GOOGLE CALENDAR CONNECTOR TOOLS
Direct integration with Google Calendar REST API v3.
Features zero external SDK bloat (uses requests + standard python datetime).
Handles OAuth2 access token caching & silent refresh.
Produces conversational text summaries and visual tile tags for Siri-acrylic UI cards:
  - ::calendar-agenda[{...}]::
  - ::calendar-event[{...}]::
"""

import datetime
import json
import re
import time
import urllib.parse
from typing import Any, Optional

import requests
from auth_manager import (
    get_calendar_user_tokens,
    load_calendar_client_credentials,
)

CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"

NOT_CONNECTED_MSG = (
    "Google Calendar is not connected yet. Please click 'Connect with Google Calendar' "
    "in the bottom tray under Settings -> Authentication -> Google Calendar Connector."
)

# In-memory access token cache
_cached_access_token: Optional[str] = None
_token_expiry_timestamp: float = 0.0


# ---------------------------------------------------------------------------
# Auth & Token Management
# ---------------------------------------------------------------------------

def get_valid_access_token(force_refresh: bool = False) -> str:
    """
    Returns a valid Google OAuth access token.
    Uses in-memory cache if token is still valid (>60s remaining),
    otherwise silently refreshes via Google's token endpoint.
    """
    global _cached_access_token, _token_expiry_timestamp

    now = time.time()
    if not force_refresh and _cached_access_token and (now < _token_expiry_timestamp - 60):
        return _cached_access_token

    refresh_token, _ = get_calendar_user_tokens()
    if not refresh_token:
        raise ValueError(NOT_CONNECTED_MSG)

    client_id, client_secret, _ = load_calendar_client_credentials()
    if not client_id or not client_secret:
        raise ValueError(
            "Missing Google OAuth Client credentials. Ensure credentials.json exists "
            "or enter custom credentials in Settings."
        )

    # Refresh the token
    try:
        resp = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            headers={"Accept": "application/json"},
            timeout=12,
        )
        if resp.status_code != 200:
            raise ValueError(f"Google token refresh failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        new_token = data.get("access_token")
        if not new_token:
            raise ValueError(f"Google response did not contain access_token: {resp.text}")

        expires_in = float(data.get("expires_in", 3600))
        _cached_access_token = new_token
        _token_expiry_timestamp = now + expires_in
        return new_token
    except requests.RequestException as e:
        raise ValueError(f"Network error refreshing Google Calendar token: {str(e)}")


def _api_request(
    method: str,
    endpoint: str,
    params: Optional[dict[str, Any]] = None,
    json_data: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Sends an authenticated request to the Google Calendar API."""
    token = get_valid_access_token()
    url = f"{CALENDAR_API_BASE}/{endpoint.lstrip('/')}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    resp = requests.request(
        method=method,
        url=url,
        headers=headers,
        params=params,
        json=json_data,
        timeout=15,
    )

    # Handle expired token retry once
    if resp.status_code == 401:
        token = get_valid_access_token(force_refresh=True)
        headers["Authorization"] = f"Bearer {token}"
        resp = requests.request(
            method=method,
            url=url,
            headers=headers,
            params=params,
            json=json_data,
            timeout=15,
        )

    if resp.status_code == 204:
        return {}

    if not resp.ok:
        try:
            err_json = resp.json()
            err_msg = err_json.get("error", {}).get("message", resp.text)
        except Exception:
            err_msg = resp.text
        raise ValueError(f"Google Calendar API Error ({resp.status_code}): {err_msg}")

    return resp.json()


# ---------------------------------------------------------------------------
# Date & Time Parsing Helpers
# ---------------------------------------------------------------------------

_cached_primary_timezone: Optional[str] = None


def _get_calendar_timezone() -> str:
    """Returns the primary Google Calendar's IANA timezone (e.g. 'Africa/Nairobi') cached in memory."""
    global _cached_primary_timezone
    if _cached_primary_timezone:
        return _cached_primary_timezone
    try:
        data = _api_request("GET", "calendars/primary")
        tz = data.get("timeZone")
        if tz:
            _cached_primary_timezone = tz
            return tz
    except Exception:
        pass
    return "UTC"


def _get_local_tz():
    """Returns local system timezone."""
    return datetime.datetime.now().astimezone().tzinfo


_WEEKDAYS = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tue": 1, "tues": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "thur": 3, "thurs": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}

_DATE_PARSE_FORMATS = (
    "%Y-%m-%d", "%Y/%m/%d",
    "%B %d, %Y", "%B %d %Y", "%b %d, %Y", "%b %d %Y",
    "%B %d", "%b %d", "%d %B %Y", "%d %b %Y", "%d %B", "%d %b",
)


def _parse_date_bounds(date_str: str, time_range: str = "day") -> tuple[str, str, str]:
    """
    Calculates RFC 3339 start and end timestamps and human label for queries.
    Supports 'today', 'tomorrow', 'this_week', 'week', weekdays ('saturday'), or explicit dates.
    """
    now = datetime.datetime.now().astimezone()
    tz = now.tzinfo
    clean_date = (date_str or "today").strip().lower()

    if clean_date in ("today", "now"):
        start_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
        label = "Today"
    elif clean_date == "tomorrow":
        tomorrow = now + datetime.timedelta(days=1)
        start_dt = tomorrow.replace(hour=0, minute=0, second=0, microsecond=0)
        label = "Tomorrow"
    elif clean_date in ("this_week", "week"):
        start_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end_dt = start_dt + datetime.timedelta(days=7)
        return start_dt.isoformat(), end_dt.isoformat(), "This Week"
    else:
        # Check weekdays
        matched_weekday = None
        for w_name, w_idx in _WEEKDAYS.items():
            if re.search(r"\b" + w_name + r"\b", clean_date):
                matched_weekday = w_idx
                break

        if matched_weekday is not None:
            days_ahead = (matched_weekday - now.weekday()) % 7
            if days_ahead == 0 and "next" in clean_date:
                days_ahead = 7
            target = now + datetime.timedelta(days=days_ahead)
            start_dt = target.replace(hour=0, minute=0, second=0, microsecond=0)
            label = start_dt.strftime("%A, %b %d")
        else:
            # Try parsing explicit date formats
            parsed_dt = None
            for fmt in _DATE_PARSE_FORMATS:
                try:
                    dt = datetime.datetime.strptime(clean_date, fmt)
                    if dt.year == 1900:
                        dt = dt.replace(year=now.year)
                    parsed_dt = dt.replace(tzinfo=tz, hour=0, minute=0, second=0, microsecond=0)
                    break
                except ValueError:
                    pass

            if parsed_dt:
                start_dt = parsed_dt
                label = start_dt.strftime("%A, %b %d")
            else:
                # Fallback to today
                start_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
                label = "Today"

    if time_range == "week":
        end_dt = start_dt + datetime.timedelta(days=7)
        label = f"Week of {start_dt.strftime('%b %d')}"
    else:
        end_dt = start_dt + datetime.timedelta(days=1)

    return start_dt.isoformat(), end_dt.isoformat(), label


def _parse_user_datetime(dt_str: str, base_date: Optional[datetime.datetime] = None) -> datetime.datetime:
    """
    Parses flexible date/time strings into a timezone-aware datetime.
    Supports ISO formats, 'YYYY-MM-DD HH:MM', 'saturday at 3pm', 'tomorrow at 2pm', 'today 15:30', '4:00 PM', etc.
    """
    now = datetime.datetime.now().astimezone()
    local_tz = now.tzinfo
    text = dt_str.strip().lower()

    # 1. ISO 8601 full string
    try:
        iso_parsed = datetime.datetime.fromisoformat(dt_str)
        if iso_parsed.tzinfo is None:
            iso_parsed = iso_parsed.replace(tzinfo=local_tz)
        return iso_parsed
    except Exception:
        pass

    # 2. Standard format YYYY-MM-DD HH:MM
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M"):
        try:
            p = datetime.datetime.strptime(dt_str.strip(), fmt)
            return p.replace(tzinfo=local_tz)
        except Exception:
            pass

    # 3. Relative date keywords & weekdays
    target_date = base_date or now
    matched_weekday = None
    for w_name, w_idx in _WEEKDAYS.items():
        if re.search(r"\b" + w_name + r"\b", text):
            matched_weekday = w_idx
            text = re.sub(r"\b" + w_name + r"\b", " ", text).strip()
            break

    if matched_weekday is not None:
        days_ahead = (matched_weekday - now.weekday()) % 7
        if days_ahead == 0 and "next" in text:
            days_ahead = 7
        target_date = now + datetime.timedelta(days=days_ahead)
    elif "tomorrow" in text:
        target_date = now + datetime.timedelta(days=1)
        text = text.replace("tomorrow", " ").strip()
    elif "today" in text:
        target_date = now
        text = text.replace("today", " ").strip()

    text = text.replace("at", " ").replace("from", " ").strip()

    # Match time format e.g. "3pm", "3:30pm", "14:00", "4 pm"
    time_match = re.search(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", text)
    if time_match:
        hour = int(time_match.group(1))
        minute = int(time_match.group(2) or 0)
        ampm = time_match.group(3)

        if ampm:
            if ampm == "pm" and hour < 12:
                hour += 12
            elif ampm == "am" and hour == 12:
                hour = 0

        return target_date.replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=local_tz)

    # Fallback to 9am on target date or now + 1 hour
    if target_date.date() != now.date():
        return target_date.replace(hour=9, minute=0, second=0, microsecond=0, tzinfo=local_tz)
    return (now + datetime.timedelta(hours=1)).replace(minute=0, second=0, microsecond=0, tzinfo=local_tz)


def _find_conflicts_for_window(
    dt_start: datetime.datetime,
    dt_end: datetime.datetime,
    exclude_event_id: str = "",
) -> tuple[list[dict[str, Any]], str]:
    """
    Finds existing events on the primary calendar that overlap with [dt_start, dt_end].
    Returns (conflicts_list, suggested_slot_string).
    """
    params = {
        "timeMin": dt_start.isoformat(),
        "timeMax": dt_end.isoformat(),
        "singleEvents": True,
        "orderBy": "startTime",
    }
    data = _api_request("GET", "calendars/primary/events", params=params)
    items = data.get("items", [])

    conflicts = []
    latest_end_dt = dt_end

    for item in items:
        if item.get("status") == "cancelled":
            continue
        if exclude_event_id and item.get("id") == exclude_event_id:
            continue

        start_info = item.get("start", {})
        end_info = item.get("end", {})

        # Skip all-day events without a specific time
        if "dateTime" not in start_info:
            continue

        try:
            ev_start = datetime.datetime.fromisoformat(start_info["dateTime"]).astimezone()
            ev_end = datetime.datetime.fromisoformat(end_info["dateTime"]).astimezone()
        except Exception:
            continue

        # Check strict overlap: ev_start < dt_end and ev_end > dt_start
        if ev_start < dt_end and ev_end > dt_start:
            _, time_str, *_ = _format_event_time(start_info, end_info)
            summary = item.get("summary", "(No Title)")
            location = item.get("location", "")
            conflicts.append({
                "id": item.get("id", ""),
                "summary": summary,
                "time": time_str,
                "location": location,
                "start": ev_start,
                "end": ev_end,
            })
            if ev_end > latest_end_dt:
                latest_end_dt = ev_end

    suggested_slot = ""
    if conflicts:
        req_duration = dt_end - dt_start
        suggested_end = latest_end_dt + req_duration
        suggested_slot = (
            f"Free from {latest_end_dt.strftime('%I:%M %p').lstrip('0')} onwards "
            f"({latest_end_dt.strftime('%I:%M %p').lstrip('0')} – {suggested_end.strftime('%I:%M %p').lstrip('0')})"
        )

    return conflicts, suggested_slot


def _format_event_time(start_raw: dict, end_raw: dict) -> tuple[str, str, bool, str, str, str]:
    """Formats event start/end into human friendly strings (e.g. '2:00 PM - 3:00 PM') and date breakdown."""
    if "date" in start_raw and "dateTime" not in start_raw:
        # All day event
        date_str = start_raw["date"]
        try:
            d = datetime.date.fromisoformat(date_str)
            return d.strftime("%A, %b %d"), "All Day", True, d.strftime("%a").upper(), str(d.day), d.strftime("%b").upper()
        except Exception:
            return date_str, "All Day", True, "EVENT", "1", ""

    dt_start = datetime.datetime.fromisoformat(start_raw.get("dateTime", "")).astimezone()
    dt_end = datetime.datetime.fromisoformat(end_raw.get("dateTime", "")).astimezone()

    time_str = f"{dt_start.strftime('%I:%M %p').lstrip('0')} – {dt_end.strftime('%I:%M %p').lstrip('0')}"
    date_str = dt_start.strftime("%A, %b %d")
    weekday = dt_start.strftime("%a").upper()
    day_number = str(dt_start.day)
    month = dt_start.strftime("%b").upper()
    return date_str, time_str, False, weekday, day_number, month


# ---------------------------------------------------------------------------
# Calendar Public Tools
# ---------------------------------------------------------------------------

def calendar_get_agenda(date: str = "today", time_range: str = "day") -> str:
    """
    Retrieves events from the user's primary Google Calendar for a specific date or time range.
    Args:
        date: Target date ('today', 'tomorrow', 'this_week', or 'YYYY-MM-DD'). Defaults to 'today'.
        time_range: 'day' or 'week'.
    """
    try:
        time_min, time_max, label = _parse_date_bounds(date, time_range)
        params = {
            "timeMin": time_min,
            "timeMax": time_max,
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": 50,
        }

        data = _api_request("GET", "calendars/primary/events", params=params)
        raw_items = data.get("items", [])

        events_for_card = []
        text_lines = []

        for item in raw_items:
            event_id = item.get("id", "")
            summary = item.get("summary", "(No Title)")
            location = item.get("location", "")
            description = item.get("description", "")
            status = item.get("status", "confirmed")
            html_link = item.get("htmlLink", "")

            # Extract Google Meet or conference link
            meet_link = item.get("hangoutLink", "")
            conf_data = item.get("conferenceData", {})
            if not meet_link and conf_data:
                entry_points = conf_data.get("entryPoints", [])
                for ep in entry_points:
                    if ep.get("entryPointType") == "video":
                        meet_link = ep.get("uri", "")
                        break

            date_str, time_str, is_all_day, weekday, day_number, month = _format_event_time(
                item.get("start", {}), item.get("end", {})
            )

            start_raw = item.get("start", {}).get("dateTime") or item.get("start", {}).get("date")
            end_raw = item.get("end", {}).get("dateTime") or item.get("end", {}).get("date")

            events_for_card.append({
                "id": event_id,
                "summary": summary,
                "time": time_str,
                "date": date_str,
                "weekday": weekday,
                "dayNumber": day_number,
                "month": month,
                "start": start_raw,
                "end": end_raw,
                "isAllDay": is_all_day,
                "location": location,
                "meetLink": meet_link,
                "htmlLink": html_link,
                "status": status,
            })

            loc_part = f" at {location}" if location else ""
            meet_part = " [Google Meet]" if meet_link else ""
            text_lines.append(f"• {time_str}: {summary}{loc_part}{meet_part}")

        card_data = {
            "mode": "agenda",
            "label": label,
            "count": len(events_for_card),
            "events": events_for_card,
        }
        card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

        if not text_lines:
            return f"You have no events scheduled for {label}. Your schedule is completely clear! ✨\n\n{card_tag}"

        events_summary = "\n".join(text_lines)
        return (
            f"Here is your agenda for {label} ({len(text_lines)} event{'s' if len(text_lines) != 1 else ''}):\n\n"
            f"{events_summary}\n\n"
            f"{card_tag}"
        )

    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"Error retrieving calendar agenda: {str(e)}"


def calendar_create_event(
    summary: str,
    start_time: str,
    end_time: str = "",
    duration_minutes: int = 60,
    description: str = "",
    location: str = "",
    add_meet_link: bool = False,
    force: bool = False,
) -> str:
    """
    Schedules a new event on Google Calendar with pre-flight conflict detection.
    Args:
        summary: Event title (e.g. 'Coffee with Sarah').
        start_time: Start date/time (e.g. 'tomorrow at 2pm', 'saturday 3pm', or ISO-8601).
        end_time: Optional end time. If omitted, duration_minutes is added to start_time.
        duration_minutes: Duration in minutes if end_time is not specified (default 60).
        description: Optional notes or agenda details.
        location: Optional location (e.g. 'Starbucks Westlands', 'Room 302').
        add_meet_link: If True, automatically creates a Google Meet video conference link.
        force: If True, overrides conflicts and schedules anyway. Defaults to False.
    """
    try:
        dt_start = _parse_user_datetime(start_time)
        if end_time:
            dt_end = _parse_user_datetime(end_time, base_date=dt_start)
        else:
            dt_end = dt_start + datetime.timedelta(minutes=max(15, duration_minutes))

        # Pre-flight conflict detection if not forced
        conflicts, suggested_slot = _find_conflicts_for_window(dt_start, dt_end)
        if conflicts and not force:
            time_window_str = (
                f"{dt_start.strftime('%A, %b %d from %I:%M %p').lstrip('0')} to "
                f"{dt_end.strftime('%I:%M %p').lstrip('0')}"
            )
            conflict_items = [
                {"summary": c["summary"], "time": c["time"], "location": c.get("location", "")}
                for c in conflicts
            ]
            card_data = {
                "mode": "availability",
                "timeWindow": time_window_str,
                "isFree": False,
                "conflicts": conflict_items,
                "suggestedSlot": suggested_slot,
            }
            card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

            conflict_lines = "\n".join([f"• {c['summary']} ({c['time']})" for c in conflict_items])
            slot_suggestion = f" You can book the free slot from {suggested_slot}." if suggested_slot else ""
            return (
                f"⚠️ Scheduling conflict detected! You already have {len(conflicts)} event{'s' if len(conflicts) != 1 else ''} "
                f"scheduled during {time_window_str}:\n{conflict_lines}\n\n"
                f"I haven't added '{summary}' yet.{slot_suggestion} Would you like me to schedule it anyway or choose another time?\n\n"
                f"{card_tag}"
            )

        tz_name = _get_calendar_timezone()

        body: dict[str, Any] = {
            "summary": summary.strip(),
            "start": {
                "dateTime": dt_start.isoformat(),
                "timeZone": tz_name,
            },
            "end": {
                "dateTime": dt_end.isoformat(),
                "timeZone": tz_name,
            },
        }

        if description.strip():
            body["description"] = description.strip()
        if location.strip():
            body["location"] = location.strip()

        params = {}
        if add_meet_link:
            params["conferenceDataVersion"] = 1
            body["conferenceData"] = {
                "createRequest": {
                    "requestId": f"aiden-{int(time.time())}",
                    "conferenceSolutionKey": {"type": "hangoutsMeet"},
                }
            }

        created = _api_request("POST", "calendars/primary/events", params=params, json_data=body)

        event_id = created.get("id", "")
        html_link = created.get("htmlLink", "")
        meet_link = created.get("hangoutLink", "")
        if not meet_link:
            conf_data = created.get("conferenceData", {})
            for ep in conf_data.get("entryPoints", []):
                if ep.get("entryPointType") == "video":
                    meet_link = ep.get("uri", "")
                    break

        date_str, time_str, is_all_day, weekday, day_number, month = _format_event_time(
            created.get("start", {}), created.get("end", {})
        )

        diff_min = int((dt_end - dt_start).total_seconds() / 60)
        if diff_min >= 60:
            hrs = diff_min // 60
            rem = diff_min % 60
            duration_str = f"{hrs}h {rem}m" if rem else f"{hrs}h"
        else:
            duration_str = f"{diff_min}m"

        card_data = {
            "mode": "created",
            "event": {
                "id": event_id,
                "summary": summary.strip(),
                "time": time_str,
                "date": date_str,
                "weekday": weekday,
                "dayNumber": day_number,
                "month": month,
                "location": location.strip(),
                "meetLink": meet_link,
                "htmlLink": html_link,
                "duration": duration_str,
            },
        }
        card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

        meet_note = f"\nGoogle Meet Link: {meet_link}" if meet_link else ""
        loc_note = f" at {location}" if location else ""
        conflict_note = " (conflict overridden)" if (force and conflicts) else ""

        return (
            f"✅ Scheduled{conflict_note}: '{summary}' on {date_str} from {time_str}{loc_note}.{meet_note}\n\n"
            f"{card_tag}"
        )

    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"Error creating calendar event: {str(e)}"


def calendar_search_events(query: str, max_results: int = 10) -> str:
    """
    Searches upcoming and past events on the user's primary calendar matching a keyword query.
    Falls back to date-window filtering if the query is a day or date reference (e.g. 'Saturday').
    Args:
        query: Search term (e.g. 'dentist', 'Alex', 'flight').
        max_results: Maximum events to return (default 10).
    """
    try:
        now = datetime.datetime.now().astimezone()
        clean_q = query.strip()
        time_min = (now - datetime.timedelta(days=30)).isoformat()
        time_max = (now + datetime.timedelta(days=90)).isoformat()

        params = {
            "q": clean_q,
            "timeMin": time_min,
            "timeMax": time_max,
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": min(max(1, max_results), 30),
        }

        data = _api_request("GET", "calendars/primary/events", params=params)
        raw_items = data.get("items", [])

        # Smart fallback: if text query returned 0 items, check if query contains date/day references
        if not raw_items:
            lower_q = clean_q.lower()
            is_date_query = any(w in lower_q for w in _WEEKDAYS.keys()) or any(
                m in lower_q for m in ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "today", "tomorrow", "week")
            ) or bool(re.search(r"\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b", lower_q))

            if is_date_query:
                try:
                    d_min, d_max, _ = _parse_date_bounds(clean_q)
                    fb_params = {
                        "timeMin": d_min,
                        "timeMax": d_max,
                        "singleEvents": True,
                        "orderBy": "startTime",
                        "maxResults": min(max(1, max_results), 30),
                    }
                    fb_data = _api_request("GET", "calendars/primary/events", params=fb_params)
                    raw_items = fb_data.get("items", [])
                except Exception:
                    pass

        events_for_card = []
        text_lines = []

        for item in raw_items:
            event_id = item.get("id", "")
            summary = item.get("summary", "(No Title)")
            location = item.get("location", "")
            meet_link = item.get("hangoutLink", "")
            html_link = item.get("htmlLink", "")

            date_str, time_str, is_all_day, weekday, day_number, month = _format_event_time(
                item.get("start", {}), item.get("end", {})
            )

            events_for_card.append({
                "id": event_id,
                "summary": summary,
                "time": time_str,
                "date": date_str,
                "weekday": weekday,
                "dayNumber": day_number,
                "month": month,
                "location": location,
                "meetLink": meet_link,
                "htmlLink": html_link,
                "isAllDay": is_all_day,
            })

            loc_part = f" ({location})" if location else ""
            text_lines.append(f"• {date_str} [{time_str}]: {summary}{loc_part}")

        card_data = {
            "mode": "search",
            "query": clean_q,
            "count": len(events_for_card),
            "events": events_for_card,
        }
        card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

        if not raw_items:
            return f"No calendar events found matching '{clean_q}'.\n\n{card_tag}"

        summary_text = "\n".join(text_lines)
        return (
            f"Found {len(events_for_card)} event{'s' if len(events_for_card) != 1 else ''} matching '{clean_q}':\n\n"
            f"{summary_text}\n\n"
            f"{card_tag}"
        )

    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"Error searching calendar: {str(e)}"


def calendar_update_event(
    event_id: str,
    summary: str = "",
    start_time: str = "",
    end_time: str = "",
    location: str = "",
    description: str = "",
) -> str:
    """
    Updates or reschedules an existing event on Google Calendar.
    Args:
        event_id: Unique event ID.
        summary: New event title (optional).
        start_time: New start time (optional, e.g. 'tomorrow at 4pm').
        end_time: New end time (optional).
        location: New location (optional).
        description: New description (optional).
    """
    try:
        # Fetch current event details first
        existing = _api_request("GET", f"calendars/primary/events/{event_id}")
        old_date, old_time, *_ = _format_event_time(
            existing.get("start", {}), existing.get("end", {})
        )

        patch_body: dict[str, Any] = {}
        if summary.strip():
            patch_body["summary"] = summary.strip()
        if location.strip():
            patch_body["location"] = location.strip()
        if description.strip():
            patch_body["description"] = description.strip()

        if start_time.strip():
            dt_start = _parse_user_datetime(start_time)
            if end_time.strip():
                dt_end = _parse_user_datetime(end_time, base_date=dt_start)
            else:
                # Retain original duration or default 60 min
                dt_end = dt_start + datetime.timedelta(minutes=60)

            tz_name = _get_calendar_timezone()
            patch_body["start"] = {"dateTime": dt_start.isoformat(), "timeZone": tz_name}
            patch_body["end"] = {"dateTime": dt_end.isoformat(), "timeZone": tz_name}

        updated = _api_request(
            "PATCH", f"calendars/primary/events/{event_id}", json_data=patch_body
        )

        date_str, time_str, _, weekday, day_number, month = _format_event_time(
            updated.get("start", {}), updated.get("end", {})
        )
        final_summary = updated.get("summary", summary)

        card_data = {
            "mode": "updated",
            "event": {
                "id": event_id,
                "summary": final_summary,
                "time": time_str,
                "date": date_str,
                "weekday": weekday,
                "dayNumber": day_number,
                "month": month,
                "location": updated.get("location", ""),
                "htmlLink": updated.get("htmlLink", ""),
            },
            "oldTime": old_time if old_time != time_str else "",
            "newTime": time_str,
        }
        card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

        return f"✅ Updated '{final_summary}' to {date_str} at {time_str}.\n\n{card_tag}"

    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"Error updating event: {str(e)}"


def calendar_delete_event(event_id: str = "", query: str = "") -> str:
    """
    Deletes or cancels a single event from the user's Google Calendar.
    Accepts either a unique event ID or an event title/keyword to look up.
    Guarantees that at most ONE matching event is deleted.
    """
    try:
        target = (event_id or query).strip()
        if not target:
            return "Please provide an event ID or title to delete."

        actual_id = ""
        clean_title = "Event"
        deleted_time_str = ""

        # First, test if target is a direct event ID
        try:
            item = _api_request("GET", f"calendars/primary/events/{target}")
            actual_id = target
            clean_title = item.get("summary", "Event")
            d_str, t_str, *_ = _format_event_time(item.get("start", {}), item.get("end", {}))
            deleted_time_str = f"{d_str} • {t_str}"
        except Exception:
            # Not a direct ID or 404, look up by keyword/title
            now = datetime.datetime.now().astimezone()
            search_params = {
                "q": target,
                "timeMin": (now - datetime.timedelta(days=7)).isoformat(),
                "timeMax": (now + datetime.timedelta(days=60)).isoformat(),
                "singleEvents": True,
                "maxResults": 10,
            }
            search_data = _api_request("GET", "calendars/primary/events", params=search_params)
            candidates = [it for it in search_data.get("items", []) if it.get("status") != "cancelled"]

            if not candidates:
                return f"No scheduled event found matching '{target}' to delete."
            elif len(candidates) == 1:
                single = candidates[0]
                actual_id = single.get("id", "")
                clean_title = single.get("summary", "Event")
                d_str, t_str, *_ = _format_event_time(single.get("start", {}), single.get("end", {}))
                deleted_time_str = f"{d_str} • {t_str}"
            else:
                # Multiple matches found! Do NOT guess or delete both!
                options = []
                for c in candidates:
                    d_str, t_str, *_ = _format_event_time(c.get("start", {}), c.get("end", {}))
                    options.append(f"• '{c.get('summary')}' on {d_str} at {t_str} (ID: {c.get('id')})")
                return (
                    f"⚠️ Found multiple events matching '{target}'. Which one would you like to delete?\n"
                    + "\n".join(options)
                )

        if not actual_id:
            return f"Could not locate event '{target}' to delete."

        _api_request("DELETE", f"calendars/primary/events/{actual_id}")

        card_data = {
            "mode": "deleted",
            "event": {
                "id": actual_id,
                "summary": clean_title,
                "time": deleted_time_str,
            },
            "label": clean_title,
            "oldTime": deleted_time_str,
        }
        card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

        return f"🗑️ '{clean_title}' has been successfully deleted from your calendar.\n\n{card_tag}"

    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"Error deleting event: {str(e)}"


def calendar_check_availability(
    start_time: str = "",
    end_time: str = "",
    date: str = "",
    time_range: str = "day",
) -> str:
    """
    Checks if the user has any conflicting events or is free during a requested time window,
    OR scans an entire day/week to detect mutual overlapping conflicts between existing events.
    Args:
        start_time: Start of requested window (e.g. 'tomorrow 2pm') or target day ('saturday', 'this_week').
        end_time: End of requested window (e.g. 'tomorrow 4pm').
        date: Target date or range ('today', 'tomorrow', 'saturday', 'this_week', or 'YYYY-MM-DD').
        time_range: 'day' or 'week'.
    """
    try:
        # Determine mode: Whole Day/Week Range Scan vs Specific Time Window
        lower_start = start_time.lower().strip()
        is_range_scan = (
            bool(date.strip())
            or not end_time.strip()
            or any(w in lower_start for w in ("week", "this_week", "schedule", "programm", "program", "all", "overview"))
            or (lower_start in _WEEKDAYS)
        )

        if is_range_scan:
            target_date_str = date.strip() or start_time.strip() or "this_week"
            scope_range = "week" if ("week" in target_date_str.lower() or time_range == "week") else time_range
            time_min, time_max, label = _parse_date_bounds(target_date_str, scope_range)

            params = {
                "timeMin": time_min,
                "timeMax": time_max,
                "singleEvents": True,
                "orderBy": "startTime",
                "maxResults": 50,
            }
            data = _api_request("GET", "calendars/primary/events", params=params)
            raw_items = [it for it in data.get("items", []) if it.get("status") != "cancelled"]

            parsed_events = []
            for item in raw_items:
                start_raw = item.get("start", {})
                end_raw = item.get("end", {})
                if "dateTime" not in start_raw:
                    continue  # skip untimed all-day events in collision analysis
                try:
                    s_dt = datetime.datetime.fromisoformat(start_raw["dateTime"]).astimezone()
                    e_dt = datetime.datetime.fromisoformat(end_raw["dateTime"]).astimezone()
                    _, t_str, *_ = _format_event_time(start_raw, end_raw)
                    parsed_events.append({
                        "id": item.get("id"),
                        "summary": item.get("summary", "(No Title)"),
                        "start": s_dt,
                        "end": e_dt,
                        "time": t_str,
                        "location": item.get("location", ""),
                    })
                except Exception:
                    continue

            # Check pairwise collisions
            collision_items = []
            collision_lines = []
            for i in range(len(parsed_events)):
                for j in range(i + 1, len(parsed_events)):
                    ev1 = parsed_events[i]
                    ev2 = parsed_events[j]
                    if ev1["start"] < ev2["end"] and ev1["end"] > ev2["start"]:
                        pair_title = f"{ev1['summary']} & {ev2['summary']}"
                        pair_time = f"{ev1['time']} overlaps with {ev2['time']}"
                        collision_items.append({
                            "summary": pair_title,
                            "time": pair_time,
                            "location": ev1.get("location") or ev2.get("location", ""),
                        })
                        collision_lines.append(f"• {pair_title} ({pair_time})")

            has_conflicts = len(collision_items) > 0
            card_data = {
                "mode": "availability",
                "timeWindow": label,
                "isFree": not has_conflicts,
                "conflicts": collision_items,
                "suggestedSlot": "",
            }
            card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

            if not has_conflicts:
                return (
                    f"✅ Scanned schedule for {label}: No overlapping events found! Everything is clearly spaced.\n\n"
                    f"{card_tag}"
                )

            summary_text = "\n".join(collision_lines)
            return (
                f"⚠️ Found {len(collision_items)} overlapping event conflict{'s' if len(collision_items) != 1 else ''} in {label}:\n"
                f"{summary_text}\n\n"
                f"{card_tag}"
            )

        # Standard Single Window Check
        dt_start = _parse_user_datetime(start_time)
        dt_end = _parse_user_datetime(end_time, base_date=dt_start)
        conflicts, suggested_slot = _find_conflicts_for_window(dt_start, dt_end)

        time_window_str = (
            f"{dt_start.strftime('%A, %b %d from %I:%M %p').lstrip('0')} to "
            f"{dt_end.strftime('%I:%M %p').lstrip('0')}"
        )

        conflict_lines = []
        conflict_items = []
        for c in conflicts:
            conflict_lines.append(f"• {c['summary']} ({c['time']})")
            conflict_items.append({
                "summary": c["summary"],
                "time": c["time"],
                "location": c.get("location", ""),
            })

        card_data = {
            "mode": "availability",
            "timeWindow": time_window_str,
            "isFree": len(conflicts) == 0,
            "conflicts": conflict_items,
            "suggestedSlot": suggested_slot,
        }
        card_tag = f"::calendar-card[{json.dumps(card_data)}]::"

        if not conflicts:
            return f"✅ You are completely free during {time_window_str}. No conflicting events!\n\n{card_tag}"

        conflicts_formatted = "\n".join(conflict_lines)
        slot_note = f"\nSuggested slot: {suggested_slot}" if suggested_slot else ""
        return (
            f"⚠️ You have {len(conflicts)} conflicting event{'s' if len(conflicts) != 1 else ''} during {time_window_str}:\n"
            f"{conflicts_formatted}{slot_note}\n\n"
            f"{card_tag}"
        )

    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"Error checking availability: {str(e)}"


CALENDAR_TOOLS = {
    "calendar_get_agenda": calendar_get_agenda,
    "calendar_create_event": calendar_create_event,
    "calendar_search_events": calendar_search_events,
    "calendar_update_event": calendar_update_event,
    "calendar_delete_event": calendar_delete_event,
    "calendar_check_availability": calendar_check_availability,
}


# ---------------------------------------------------------------------------
# OpenAI Tool Schemas
# ---------------------------------------------------------------------------

CALENDAR_TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "calendar_get_agenda",
            "description": "Retrieves agenda and scheduled events from Google Calendar for today, tomorrow, this week, a day of week (e.g. 'saturday'), or a specific date ('YYYY-MM-DD'). ALWAYS use this tool when the user asks what events are on a specific day or asks to clear/inspect a day. Returns a ::calendar-card[...]:: tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Target date or day: 'today', 'tomorrow', 'saturday', 'this_week', or 'YYYY-MM-DD'. Defaults to 'today'.",
                    },
                    "time_range": {
                        "type": "string",
                        "enum": ["day", "week"],
                        "description": "Scope of the query: 'day' (default) or 'week'.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calendar_create_event",
            "description": "Schedules a new event on Google Calendar. Automatically checks for overlapping scheduling conflicts: if a conflict is found and force=false, it returns a conflict availability card so the user can choose. Returns a ::calendar-card[...]:: tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Title or summary of the event (e.g. 'Lunch with Sarah', 'Dentist appointment').",
                    },
                    "start_time": {
                        "type": "string",
                        "description": "Start time (e.g. 'tomorrow at 2pm', 'saturday 3pm', or ISO timestamp).",
                    },
                    "end_time": {
                        "type": "string",
                        "description": "Optional end time. If omitted, duration_minutes is added to start_time.",
                    },
                    "duration_minutes": {
                        "type": "integer",
                        "description": "Duration in minutes if end_time is not provided (default 60).",
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional notes or details for the event.",
                    },
                    "location": {
                        "type": "string",
                        "description": "Optional location or room name.",
                    },
                    "add_meet_link": {
                        "type": "boolean",
                        "description": "Whether to generate a Google Meet video conference link for the event.",
                    },
                    "force": {
                        "type": "boolean",
                        "description": "Set to true to override and schedule even if there are overlapping conflicts. Defaults to false.",
                    },
                },
                "required": ["summary", "start_time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calendar_search_events",
            "description": "Searches events on Google Calendar by keyword, title, person, or notes (e.g. 'dentist', 'football', 'meeting with Alex'). NOTE: To inspect or view all events on a specific day (e.g. 'Saturday', 'tomorrow'), use calendar_get_agenda instead. Returns a ::calendar-card[...]:: tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search keyword or name to locate in calendar events.",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of matching events to return (default 10).",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calendar_update_event",
            "description": "Updates or reschedules an existing event on Google Calendar, returning a ::calendar-card[...]:: tag. Always preserve and embed the card tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "event_id": {
                        "type": "string",
                        "description": "Unique Google Calendar event ID to update.",
                    },
                    "summary": {
                        "type": "string",
                        "description": "New title for the event (optional).",
                    },
                    "start_time": {
                        "type": "string",
                        "description": "New start time (optional, e.g. 'tomorrow at 4pm').",
                    },
                    "end_time": {
                        "type": "string",
                        "description": "New end time (optional).",
                    },
                    "location": {
                        "type": "string",
                        "description": "New location (optional).",
                    },
                    "description": {
                        "type": "string",
                        "description": "New description or notes (optional).",
                    },
                },
                "required": ["event_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calendar_delete_event",
            "description": "Deletes or cancels a single event from Google Calendar using either the event ID or the event title. Returns a ::calendar-card[...]:: tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "event_id": {
                        "type": "string",
                        "description": "Unique Google Calendar event ID or exact title/keyword of the event to delete.",
                    },
                },
                "required": ["event_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calendar_check_availability",
            "description": "Checks if the user has conflicting events or is free during a time window, OR scans an entire day or week to detect any overlapping double-bookings between scheduled events. Returns a ::calendar-card[...]:: tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_time": {
                        "type": "string",
                        "description": "Start of window (e.g. 'tomorrow 2pm') or target day/range (e.g. 'saturday', 'this_week').",
                    },
                    "end_time": {
                        "type": "string",
                        "description": "End of window (e.g. 'tomorrow 5pm'). Leave empty when checking a full day or week for mutual overlaps.",
                    },
                    "date": {
                        "type": "string",
                        "description": "Target date or range to scan: 'today', 'tomorrow', 'saturday', 'this_week', or 'YYYY-MM-DD'.",
                    },
                    "time_range": {
                        "type": "string",
                        "enum": ["day", "week"],
                        "description": "Scope of the query: 'day' (default) or 'week'.",
                    },
                },
                "required": [],
            },
        },
    },
]
