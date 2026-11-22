"""
AIDEN GMAIL CONNECTOR TOOLS
Handles direct IMAP & SMTP communication with Gmail via Google App Passwords.
Zero external pip dependencies (uses Python standard libraries: imaplib, smtplib, email).
Credentials fetched on-demand from Windows Credential Manager via auth_manager.
All operations use permanent IMAP UIDs (Unique Identifiers) for rock-solid stability.
"""

import atexit
import datetime
import email
import html
import imaplib
import json
import re
import smtplib
import socket
import threading
import time
from email.header import decode_header
from email.message import EmailMessage
from email.policy import default
from email.utils import parsedate_to_datetime, parseaddr

from auth_manager import get_gmail_credentials

GMAIL_IMAP_HOST = "imap.gmail.com"
GMAIL_IMAP_PORT = 993
GMAIL_SMTP_HOST = "smtp.gmail.com"
GMAIL_SMTP_PORT = 465

IMAP_NOOP_IDLE_THRESHOLD_SEC = 45.0
IMAP_MAX_IDLE_SEC = 1200.0  # Proactively refresh connections idle > 20 min (Gmail drops ~29m)

NOT_CONNECTED_MSG = (
    "Gmail is not connected yet. Please add your Gmail address and 16-character Google App Password "
    "in the bottom tray under Settings -> Authentication -> Gmail Connector."
)


# ---------------------------------------------------------------------------
# Internal Helpers & Persistent Warm IMAP Session Manager
# ---------------------------------------------------------------------------

def _get_credentials() -> tuple[str, str]:
    """Retrieves Gmail credentials or raises ValueError if missing."""
    email_addr, app_pwd = get_gmail_credentials()
    if not email_addr or not app_pwd:
        raise ValueError(NOT_CONNECTED_MSG)
    return email_addr, app_pwd


def _connect_imap(email_addr: str, app_pwd: str) -> imaplib.IMAP4_SSL:
    """Establishes an authenticated IMAP SSL connection to Gmail with TCP_NODELAY."""
    try:
        mail = imaplib.IMAP4_SSL(GMAIL_IMAP_HOST, GMAIL_IMAP_PORT, timeout=20)
        try:
            sock = mail.socket()
            if sock is not None:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        mail.login(email_addr, app_pwd)
        return mail
    except imaplib.IMAP4.error as e:
        raise ValueError(f"Gmail IMAP Authentication failed: {str(e)}. Verify your Google App Password.")
    except Exception as e:
        raise ValueError(f"Could not connect to Gmail IMAP: {str(e)}")


def _close_imap_quietly(mail: imaplib.IMAP4_SSL | None) -> None:
    """Closes an IMAP socket without blocking on network round-trip errors."""
    if mail is None:
        return
    try:
        mail.shutdown()
    except Exception:
        try:
            sock = mail.socket()
            if sock is not None:
                sock.close()
        except Exception:
            pass


class _WarmImapSession:
    """
    Thread-safe persistent IMAP session parked on INBOX (read-write, using BODY.PEEK for all
    read-only operations so unread state is never touched). Eliminates repeated TCP/TLS, LOGIN,
    SELECT, LIST, and LOGOUT round trips across consecutive Gmail tool calls.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._mail: imaplib.IMAP4_SSL | None = None
        self._creds: tuple[str, str] | None = None
        self._selected_inbox: bool = False
        self._last_used: float = 0.0
        self._folder_cache: dict[str, str] = {}
        self._warming: bool = False

    def _drop_locked(self) -> None:
        _close_imap_quietly(self._mail)
        self._mail = None
        self._selected_inbox = False
        self._last_used = 0.0

    def _ensure_ready_locked(self, email_addr: str, app_pwd: str, select_inbox: bool = True) -> imaplib.IMAP4_SSL:
        creds = (email_addr, app_pwd)
        now = time.monotonic()

        # Invalidate if credentials changed or connection sat idle too long
        if self._mail is not None:
            if self._creds != creds:
                self._drop_locked()
                self._folder_cache.clear()
            elif (now - self._last_used) > IMAP_MAX_IDLE_SEC:
                self._drop_locked()
            elif (now - self._last_used) > IMAP_NOOP_IDLE_THRESHOLD_SEC:
                try:
                    status, _ = self._mail.noop()
                    if status != "OK":
                        self._drop_locked()
                except Exception:
                    self._drop_locked()

        if self._mail is None:
            mail = _connect_imap(email_addr, app_pwd)
            self._mail = mail
            self._creds = creds
            self._selected_inbox = False

        if select_inbox and not self._selected_inbox:
            status, _ = self._mail.select("INBOX", readonly=False)
            if status != "OK":
                self._drop_locked()
                raise imaplib.IMAP4.abort("Failed to select INBOX")
            self._selected_inbox = True

        self._last_used = time.monotonic()
        return self._mail

    def run(self, email_addr: str, app_pwd: str, op, select_inbox: bool = True):
        """
        Executes `op(mail)` on the warm IMAP connection with automatic 1-time transparent
        reconnect & retry if Gmail closed the socket in the background.
        """
        with self._lock:
            last_err = None
            for attempt in range(2):
                try:
                    mail = self._ensure_ready_locked(email_addr, app_pwd, select_inbox=select_inbox)
                    result = op(mail)
                    self._last_used = time.monotonic()
                    return result
                except ValueError:
                    # Authentication / configuration error: do not retry
                    self._drop_locked()
                    raise
                except (imaplib.IMAP4.abort, imaplib.IMAP4.error, OSError, EOFError, TimeoutError) as e:
                    last_err = e
                    self._drop_locked()
                    if attempt == 0:
                        continue
                    raise
                except Exception:
                    self._drop_locked()
                    raise
            if last_err is not None:
                raise last_err

    def get_cached_folder(self, mail: imaplib.IMAP4_SSL, target_flag: str, fallback_name: str) -> str:
        """Resolves & caches specialized Gmail folders (e.g. \\Drafts) with at most one LIST/session."""
        key = target_flag.lower()
        if key in self._folder_cache:
            return self._folder_cache[key]
        resolved = _find_folder(mail, target_flag, fallback_name)
        self._folder_cache[key] = resolved
        return resolved

    def warm_async(self) -> None:
        """Pre-warms the IMAP connection & INBOX selection in a background daemon thread."""
        with self._lock:
            if self._warming:
                return
            self._warming = True

        def _worker():
            try:
                email_addr, app_pwd = get_gmail_credentials()
                if not email_addr or not app_pwd:
                    return
                with self._lock:
                    try:
                        self._ensure_ready_locked(email_addr, app_pwd, select_inbox=True)
                    except Exception:
                        self._drop_locked()
            finally:
                with self._lock:
                    self._warming = False

        threading.Thread(target=_worker, name="aiden-gmail-prewarm", daemon=True).start()

    def reset(self) -> None:
        with self._lock:
            self._drop_locked()
            self._creds = None
            self._folder_cache.clear()


_IMAP_SESSION = _WarmImapSession()
atexit.register(_IMAP_SESSION.reset)


def warm_gmail_connection() -> None:
    """Public hook to pre-warm Gmail's persistent IMAP session asynchronously (non-blocking)."""
    _IMAP_SESSION.warm_async()


def reset_gmail_connection() -> None:
    """Public hook to close & reset the warm Gmail IMAP session (e.g. after credential changes)."""
    _IMAP_SESSION.reset()


_UID_RE = re.compile(rb"\bUID\s+(\d+)\b", re.IGNORECASE)
_FLAGS_RE = re.compile(rb"\bFLAGS\s*\(([^)]*)\)", re.IGNORECASE)
_MSG_START_RE = re.compile(rb"^\s*\d+\s+\(")


def _parse_batched_fetch(fetch_data: list | None) -> dict[str, dict]:
    """
    Parses a single batched `mail.uid('fetch', b'u1,u2,...', '(UID FLAGS BODY.PEEK[HEADER.FIELDS ...] BODY.PEEK[1]<0.350>)')`
    response into a `{uid_str: {'headers': bytes, 'preview': str, 'is_unread': bool}}` lookup map.
    """
    records: dict[str, dict] = {}
    if not fetch_data:
        return records

    current: dict = {"uid": None, "flags": b"", "headers": b"", "preview": ""}

    def _flush() -> None:
        uid = current.get("uid")
        if uid:
            flags = current.get("flags", b"")
            records[uid] = {
                "headers": current.get("headers", b""),
                "preview": current.get("preview", ""),
                "is_unread": b"\\Seen" not in flags,
            }
        current["uid"] = None
        current["flags"] = b""
        current["headers"] = b""
        current["preview"] = ""

    for item in fetch_data:
        if isinstance(item, tuple) and len(item) >= 2:
            meta = item[0] if isinstance(item[0], (bytes, bytearray)) else b""
            payload = item[1] if isinstance(item[1], (bytes, bytearray)) else b""

            if _MSG_START_RE.match(meta) and (current["uid"] or current["headers"] or current["preview"]):
                _flush()

            uid_m = _UID_RE.search(meta)
            if uid_m:
                current["uid"] = uid_m.group(1).decode("ascii", errors="ignore")

            flags_m = _FLAGS_RE.search(meta)
            if flags_m:
                current["flags"] = flags_m.group(1)

            if b"HEADER.FIELDS" in meta:
                current["headers"] = bytes(payload)
            elif b"BODY[" in meta or b"BODY.PEEK[" in meta:
                current["preview"] = bytes(payload).decode("utf-8", errors="replace")

        elif isinstance(item, (bytes, bytearray)):
            raw = bytes(item)
            uid_m = _UID_RE.search(raw)
            if uid_m and not current["uid"]:
                current["uid"] = uid_m.group(1).decode("ascii", errors="ignore")
            flags_m = _FLAGS_RE.search(raw)
            if flags_m:
                current["flags"] = flags_m.group(1)
            if raw.strip().endswith(b")"):
                _flush()

    _flush()
    return records


def _escape_xgmraw_query(query: str) -> str:
    """Safely escapes double quotes and backslashes for Gmail IMAP X-GM-RAW search strings."""
    return query.replace("\\", "\\\\").replace('"', '\\"')


def _clean_preview_snippet(body_preview: str) -> str:
    """Strips MIME/HTML noise from a 350-byte IMAP preview snippet."""
    clean_snippet = _clean_html_text(body_preview).replace("\n", " ")
    clean_snippet = re.sub(
        r"Content-(Type|Transfer-Encoding|Disposition):[^\n;]+(;[^\n]+)?",
        " ",
        clean_snippet,
        flags=re.IGNORECASE,
    )
    clean_snippet = re.sub(r'boundary="?[^"\s]+"?', " ", clean_snippet, flags=re.IGNORECASE)
    clean_snippet = re.sub(r"--[a-zA-Z0-9_-]+", " ", clean_snippet)
    clean_snippet = re.sub(r"<meta[^>]*>", " ", clean_snippet, flags=re.IGNORECASE)
    clean_snippet = re.sub(r"\s+", " ", clean_snippet).strip()
    if len(clean_snippet) > 160:
        clean_snippet = clean_snippet[:157] + "..."
    return clean_snippet


def _decode_mime_header(header_val: str | None) -> str:
    """Decodes RFC 2047 encoded email headers into clean unicode strings."""
    if not header_val:
        return ""
    try:
        parts = decode_header(header_val)
        decoded = []
        for content, encoding in parts:
            if isinstance(content, bytes):
                encoding = encoding or "utf-8"
                try:
                    decoded.append(content.decode(encoding, errors="replace"))
                except Exception:
                    decoded.append(content.decode("latin-1", errors="replace"))
            else:
                decoded.append(str(content))
        return "".join(decoded).strip()
    except Exception:
        return str(header_val).strip()


def _format_email_timestamp(date_str: str) -> str:
    """Formats RFC 2822 email Date into 'X min ago • HH:MM' or 'Yesterday • HH:MM' or 'MMM DD • HH:MM'."""
    if not date_str:
        return ""
    try:
        dt = parsedate_to_datetime(date_str)
        # Compare in local or UTC aware terms
        if dt.tzinfo is not None:
            now = datetime.datetime.now(datetime.timezone.utc)
            diff = now - dt
        else:
            now = datetime.datetime.now()
            diff = now - dt

        clock_time = dt.strftime("%H:%M")
        seconds = int(diff.total_seconds())

        if seconds < 0:
            relative = "Just now"
        elif seconds < 120:
            relative = "1 min ago"
        elif seconds < 3600:
            relative = f"{seconds // 60} min ago"
        elif seconds < 86400:
            hours = seconds // 3600
            relative = f"{hours} hr ago" if hours == 1 else f"{hours} hrs ago"
        elif seconds < 172800:
            relative = "Yesterday"
        else:
            relative = dt.strftime("%b %d")

        return f"{relative} • {clock_time}"
    except Exception:
        return date_str[:16] if len(date_str) > 16 else date_str


def _clean_sender_display(from_header: str) -> tuple[str, str]:
    """Returns (clean_display_name, email_address) from an RFC From header."""
    if not from_header:
        return "Unknown Sender", ""
    try:
        name, addr = parseaddr(from_header)
        name = _decode_mime_header(name).strip()
        addr = str(addr or "").strip()
        if not name:
            name = addr.split("@")[0] if "@" in addr else from_header
        return name, addr
    except Exception:
        return from_header, ""


def _clean_html_text(html_content: str) -> str:
    """Converts HTML email body into clean, readable plain text without markdown noise."""
    if not html_content:
        return ""
    # Strip style, script, and head blocks
    text = re.sub(r"<(style|script|head)[^>]*>.*?</\1>", "", html_content, flags=re.DOTALL | re.IGNORECASE)
    # Replace line break / paragraph tags with newlines
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", text, flags=re.IGNORECASE)
    # Strip all remaining tags and any trailing unclosed tag
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"<[^>]*$", "", text)
    # Unescape HTML entities (&amp;, &nbsp;, &lt;, etc.)
    text = html.unescape(text)
    # Normalize whitespaces and excess blank lines
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _extract_body_and_attachments(msg: email.message.Message) -> tuple[str, list[str]]:
    """Extracts plain text body (or converted HTML) and attachment names from an email message."""
    plain_parts = []
    html_parts = []
    attachments = []

    if msg.is_multipart():
        for part in msg.walk():
            fn = part.get_filename()
            if fn:
                attachments.append(_decode_mime_header(fn))
                continue

            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition", ""))
            if "attachment" in content_disposition:
                continue

            if content_type == "text/plain":
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        plain_parts.append(payload.decode(charset, errors="replace"))
                except Exception:
                    pass
            elif content_type == "text/html":
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        html_parts.append(payload.decode(charset, errors="replace"))
                except Exception:
                    pass
    else:
        fn = msg.get_filename()
        if fn:
            attachments.append(_decode_mime_header(fn))
        else:
            try:
                payload = msg.get_payload(decode=True)
                if payload:
                    charset = msg.get_content_charset() or "utf-8"
                    text = payload.decode(charset, errors="replace")
                    if msg.get_content_type() == "text/html":
                        html_parts.append(text)
                    else:
                        plain_parts.append(text)
            except Exception:
                plain_parts.append(str(msg.get_payload()))

    if plain_parts:
        body = "\n\n".join(plain_parts).strip()
    elif html_parts:
        body = _clean_html_text("\n\n".join(html_parts))
    else:
        body = "(No readable text body found in this email)"

    return body, attachments


def _find_folder(mail: imaplib.IMAP4_SSL, target_flag: str, fallback_name: str) -> str:
    """Finds a specialized Gmail folder (Drafts/Sent/All Mail) by RFC 6154 flags or fallbacks."""
    try:
        typ, folders = mail.list()
        if typ == "OK":
            for folder_entry in folders:
                folder_str = folder_entry.decode("utf-8", errors="ignore")
                if target_flag.lower() in folder_str.lower():
                    parts = folder_str.split(' "/" ')
                    if len(parts) == 2:
                        return parts[1].strip('"')
    except Exception:
        pass
    return fallback_name


# ---------------------------------------------------------------------------
# Tool Implementations (Permanent IMAP UIDs)
# ---------------------------------------------------------------------------

def gmail_list_unread_emails(max_results: int = 5) -> str:
    """Lists recent unread emails from user's Gmail inbox using permanent UIDs (single batched IMAP fetch)."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    try:
        max_n = max(1, min(int(max_results or 5), 15))

        def _op(mail: imaplib.IMAP4_SSL):
            status, data = mail.uid("search", None, "UNSEEN")
            if status != "OK" or not data or not data[0]:
                return 0, [], {}

            email_uids = data[0].split()
            total_unread = len(email_uids)
            recent_uids = email_uids[-max_n:]
            recent_uids.reverse()

            uid_set = b",".join(recent_uids)
            f_status, fetch_data = mail.uid(
                "fetch",
                uid_set,
                "(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[1]<0.350>)",
            )
            records = _parse_batched_fetch(fetch_data) if f_status == "OK" else {}
            return total_unread, recent_uids, records

        total_unread, recent_uids, records = _IMAP_SESSION.run(email_addr, app_pwd, _op, select_inbox=True)
        if total_unread == 0:
            return "You have no unread emails in your inbox right now. Everything is caught up!"

        summaries = []
        card_emails = []
        for uid in recent_uids:
            uid_str = uid.decode("utf-8")
            rec = records.get(uid_str)
            if not rec:
                continue

            msg_header = email.message_from_bytes(rec["headers"])
            subject = _decode_mime_header(msg_header.get("Subject", "(No Subject)"))
            sender = _decode_mime_header(msg_header.get("From", "Unknown Sender"))
            date = msg_header.get("Date", "")
            clean_snippet = _clean_preview_snippet(rec["preview"])

            sender_name, sender_email = _clean_sender_display(sender)
            formatted_time = _format_email_timestamp(date)

            card_emails.append({
                "id": uid_str,
                "sender": sender_name,
                "email": sender_email,
                "time": formatted_time,
                "subject": subject,
                "snippet": clean_snippet or "(No preview available)",
                "unread": True
            })

            summaries.append(
                f"* [ID: {uid_str}] From: {sender}\n"
                f"  Date: {date}\n"
                f"  Subject: {subject}\n"
                f"  Preview: {clean_snippet or '(No preview available)'}"
            )

        card_data = {
            "mode": "unread",
            "count": total_unread,
            "emails": card_emails,
            "subtitle": f"You have {total_unread} unread email{'s' if total_unread != 1 else ''}"
        }
        card_tag = f"::gmail-card[{json.dumps(card_data)}]::"

        return (
            f"=== GMAIL: {total_unread} UNREAD EMAILS (Showing latest {len(summaries)}) ===\n"
            + "\n\n".join(summaries)
            + "\n\n[AIDEN: Summarize these to the user. Offer to read, reply, archive, or mark as read by ID.]\n"
            + f"Embed this card tag directly in your reply below your answer:\n{card_tag}"
        )

    except Exception as e:
        return f"Error retrieving unread emails: {str(e)}"


def gmail_search_emails(query: str, max_results: int = 5) -> str:
    """Searches the user's Gmail inbox using keywords, sender, or subject (single batched IMAP fetch)."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    if not query or not query.strip():
        return "Search query cannot be empty."

    query = query.strip()

    try:
        max_n = max(1, min(int(max_results or 5), 15))
        escaped_q = _escape_xgmraw_query(query)

        def _op(mail: imaplib.IMAP4_SSL):
            # Gmail native X-GM-RAW searches full headers, body, and Gmail operators (from:, subject:, etc.)
            status, data = mail.uid("search", None, f'X-GM-RAW "{escaped_q}"')
            if status != "OK":
                # Only fall back to IMAP TEXT if Gmail rejected the X-GM-RAW command itself
                status, data = mail.uid("search", None, "TEXT", f'"{escaped_q}"')

            if status != "OK" or not data or not data[0]:
                return 0, [], {}

            email_uids = data[0].split()
            total_found = len(email_uids)
            recent_uids = email_uids[-max_n:]
            recent_uids.reverse()

            uid_set = b",".join(recent_uids)
            f_status, fetch_data = mail.uid(
                "fetch",
                uid_set,
                "(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[1]<0.350>)",
            )
            records = _parse_batched_fetch(fetch_data) if f_status == "OK" else {}
            return total_found, recent_uids, records

        total_found, recent_uids, records = _IMAP_SESSION.run(email_addr, app_pwd, _op, select_inbox=True)
        if total_found == 0:
            return f"No emails found matching query: \"{query}\"."

        summaries = []
        card_emails = []
        for uid in recent_uids:
            uid_str = uid.decode("utf-8")
            rec = records.get(uid_str)
            if not rec:
                continue

            msg_header = email.message_from_bytes(rec["headers"])
            subject = _decode_mime_header(msg_header.get("Subject", "(No Subject)"))
            sender = _decode_mime_header(msg_header.get("From", "Unknown Sender"))
            date = msg_header.get("Date", "")
            clean_snippet = _clean_preview_snippet(rec["preview"])

            sender_name, sender_email = _clean_sender_display(sender)
            formatted_time = _format_email_timestamp(date)

            card_emails.append({
                "id": uid_str,
                "sender": sender_name,
                "email": sender_email,
                "time": formatted_time,
                "subject": subject,
                "snippet": clean_snippet or "(No preview available)",
                "unread": rec["is_unread"]
            })

            summaries.append(
                f"* [ID: {uid_str}] From: {sender}\n"
                f"  Date: {date}\n"
                f"  Subject: {subject}\n"
                f"  Preview: {clean_snippet or '(No preview available)'}"
            )

        card_data = {
            "mode": "search",
            "query": query,
            "count": total_found,
            "emails": card_emails,
            "subtitle": f"{total_found} result{'s' if total_found != 1 else ''} matching \"{query}\""
        }
        card_tag = f"::gmail-card[{json.dumps(card_data)}]::"

        return (
            f"=== GMAIL SEARCH: \"{query}\" ({total_found} found, showing latest {len(summaries)}) ===\n"
            + "\n\n".join(summaries)
            + "\n\n[AIDEN: Present these search results to the user and offer to read, archive, or reply to any specific ID.]\n"
            + f"Embed this card tag directly in your reply below your answer:\n{card_tag}"
        )

    except Exception as e:
        return f"Error searching emails for \"{query}\": {str(e)}"


def gmail_read_email(email_id: str, mark_as_read: bool = False) -> str:
    """Reads the full content of an email by its permanent UID over the persistent warm IMAP session."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    if not email_id or not str(email_id).strip():
        return "Please provide a valid email_id to read."

    clean_id = str(email_id).strip()

    try:
        # BODY.PEEK[] never marks the message as \Seen even on a read-write INBOX selection;
        # RFC822 marks it as \Seen when mark_as_read=True without re-selecting INBOX.
        fetch_cmd = "(RFC822)" if mark_as_read else "(BODY.PEEK[])"

        def _op(mail: imaplib.IMAP4_SSL):
            status, data = mail.uid("fetch", clean_id.encode("utf-8"), fetch_cmd)
            if status != "OK" or not data or not data[0]:
                return None
            for item in data:
                if isinstance(item, tuple) and len(item) > 1:
                    return item[1]
            return None

        raw_bytes = _IMAP_SESSION.run(email_addr, app_pwd, _op, select_inbox=True)
        if not raw_bytes:
            return f"Could not find email with ID '{clean_id}'. It may have been archived or deleted."

        msg = email.message_from_bytes(raw_bytes, policy=default)
        subject = _decode_mime_header(msg.get("Subject", "(No Subject)"))
        sender = _decode_mime_header(msg.get("From", "Unknown Sender"))
        date = msg.get("Date", "")
        message_id = msg.get("Message-ID", "")

        body, attachments = _extract_body_and_attachments(msg)

        # Truncate ultra-long emails to preserve LLM token context
        truncated_note = ""
        max_chars = 4000
        if len(body) > max_chars:
            excess = len(body) - max_chars
            body = body[:max_chars]
            truncated_note = f"\n\n[Note: Email body was truncated by {excess:,} characters for brevity.]"

        att_str = ", ".join(attachments) if attachments else "None"

        sender_clean = _clean_sender_display(sender)
        _, sender_addr = parseaddr(sender)
        time_formatted = _format_email_timestamp(date)

        card_template_payload = {
            "mode": "read",
            "id": clean_id,
            "sender": sender_clean,
            "email": sender_addr or sender_clean,
            "date": time_formatted or date,
            "subject": subject,
            "summary": "<INSERT_YOUR_1_TO_2_SENTENCE_HUMAN_SUMMARY_HERE>"
        }
        card_template_json = json.dumps(card_template_payload, ensure_ascii=False)

        return (
            f"=== GMAIL MESSAGE [ID: {clean_id}] ===\n"
            f"From: {sender_clean} <{sender_addr}>\n"
            f"Date: {time_formatted or date}\n"
            f"Subject: {subject}\n"
            f"Attachments: {att_str}\n"
            f"Message-ID: {message_id}\n\n"
            f"--- CONTENT ---\n"
            f"{body}{truncated_note}\n\n"
            f"[AIDEN READ CARD INSTRUCTION:\n"
            f"1. Converse warmly and briefly with the user about this email in your signature charm.\n"
            f"2. Synthesize an executive 1-2 sentence human language summary (conversational prose, no bullet points).\n"
            f"3. Emit the card tag below in your final response, replacing <INSERT_YOUR_1_TO_2_SENTENCE_HUMAN_SUMMARY_HERE> with your natural language summary:\n"
            f"::gmail-card[{card_template_json}]::\n"
            f"4. Offer to reply or archive if appropriate.]"
        )

    except Exception as e:
        return f"Error reading email ID {clean_id}: {str(e)}"


def gmail_draft_email(to_email: str, subject: str, body: str, cc: str | None = None) -> str:
    """Creates a draft email in the user's Gmail Drafts folder without re-selecting or blocking on logout."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    if not to_email or not subject or not body:
        return "Drafting requires 'to_email', 'subject', and 'body'."

    try:
        msg = EmailMessage()
        msg["From"] = email_addr
        msg["To"] = to_email.strip()
        if cc and cc.strip():
            msg["Cc"] = cc.strip()
        msg["Subject"] = subject.strip()
        msg.set_content(body.strip())
        raw_msg = msg.as_bytes()

        def _op(mail: imaplib.IMAP4_SSL):
            drafts_folder = _IMAP_SESSION.get_cached_folder(mail, "\\Drafts", "[Gmail]/Drafts")
            # RFC 3501 APPEND writes straight into Drafts without disturbing INBOX selection
            status, _ = mail.append(
                drafts_folder,
                "(\\Draft)",
                imaplib.Time2Internaldate(time.time()),
                raw_msg,
            )
            return status, drafts_folder

        status, drafts_folder = _IMAP_SESSION.run(email_addr, app_pwd, _op, select_inbox=False)

        if status == "OK":
            return (
                f"[SUCCESS] Draft successfully created in your Gmail Drafts folder!\n"
                f"* To: {to_email.strip()}\n"
                f"* Subject: {subject.strip()}\n"
                f"* Drafts Folder: {drafts_folder}\n\n"
                f"You can review, edit, or send it anytime from your Gmail app or web browser."
            )
        else:
            return f"Could not create draft in folder '{drafts_folder}'. IMAP status: {status}"

    except Exception as e:
        return f"Error creating email draft: {str(e)}"


def gmail_send_email(to_email: str, subject: str, body: str, cc: str | None = None) -> str:
    """Sends an email immediately via Gmail SMTP (Gmail automatically saves a copy to Sent Mail)."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    if not to_email or not subject or not body:
        return "Sending requires 'to_email', 'subject', and 'body'."

    try:
        msg = EmailMessage()
        msg["From"] = email_addr
        msg["To"] = to_email.strip()
        if cc and cc.strip():
            msg["Cc"] = cc.strip()
        msg["Subject"] = subject.strip()
        msg.set_content(body.strip())

        # Send via Gmail SSL SMTP (smtp.gmail.com automatically persists every sent message in Sent Mail)
        with smtplib.SMTP_SSL(GMAIL_SMTP_HOST, GMAIL_SMTP_PORT, timeout=25) as smtp:
            smtp.login(email_addr, app_pwd)
            smtp.send_message(msg)

        return (
            f"[SUCCESS] Email successfully sent!\n"
            f"* Recipient: {to_email.strip()}\n"
            f"* Subject: {subject.strip()}\n"
            f"* From: {email_addr}\n\n"
            f"A copy has also been saved to your Gmail Sent Mail."
        )

    except smtplib.SMTPAuthenticationError as e:
        return f"SMTP Authentication failed: {str(e)}. Please check your Google App Password."
    except Exception as e:
        return f"Error sending email: {str(e)}"


def gmail_reply_email(email_id: str, body: str, reply_all: bool = False) -> str:
    """Sends a threaded reply to an existing email by its permanent UID."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    if not email_id or not body:
        return "Replying requires 'email_id' and 'body'."

    clean_id = str(email_id).strip()

    try:
        # 1. Fetch original email headers over the warm IMAP session
        def _fetch_headers(mail: imaplib.IMAP4_SSL):
            status, data = mail.uid(
                "fetch",
                clean_id.encode("utf-8"),
                "(BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT MESSAGE-ID REFERENCES)])",
            )
            if status != "OK" or not data or not data[0]:
                return None
            for item in data:
                if isinstance(item, tuple) and len(item) > 1:
                    return item[1]
            return None

        headers_raw = _IMAP_SESSION.run(email_addr, app_pwd, _fetch_headers, select_inbox=True)
        if not headers_raw:
            return f"Could not find original email with ID '{clean_id}' to reply to."

        orig = email.message_from_bytes(headers_raw)
        orig_from = _decode_mime_header(orig.get("From", ""))
        orig_subject = _decode_mime_header(orig.get("Subject", ""))
        orig_msg_id = orig.get("Message-ID", "").strip()
        orig_refs = orig.get("References", "").strip()

        # Format Subject: ensure it starts with Re:
        if orig_subject.lower().startswith("re:"):
            new_subject = orig_subject
        else:
            new_subject = f"Re: {orig_subject}" if orig_subject else "Re: Your message"

        # Construct reply message
        reply = EmailMessage()
        reply["From"] = email_addr
        reply["To"] = orig_from
        reply["Subject"] = new_subject

        if reply_all and orig.get("Cc"):
            reply["Cc"] = orig.get("Cc")

        # Threading headers
        if orig_msg_id:
            reply["In-Reply-To"] = orig_msg_id
            reply["References"] = f"{orig_refs} {orig_msg_id}".strip()

        reply.set_content(body.strip())

        # 2. Send via SMTP (smtp.gmail.com automatically saves a copy in Sent Mail)
        with smtplib.SMTP_SSL(GMAIL_SMTP_HOST, GMAIL_SMTP_PORT, timeout=25) as smtp:
            smtp.login(email_addr, app_pwd)
            smtp.send_message(reply)

        return (
            f"[SUCCESS] Threaded reply sent successfully!\n"
            f"* To: {orig_from}\n"
            f"* Subject: {new_subject}\n"
            f"* In-Reply-To ID: {orig_msg_id or clean_id}"
        )

    except Exception as e:
        return f"Error sending reply to email ID {clean_id}: {str(e)}"


def gmail_mark_emails_as_read(query: str | None = None, email_ids: str | None = None, all_unread: bool = True) -> str:
    """Marks unread emails in the user's Gmail inbox as read using permanent UIDs."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    try:
        def _op(mail: imaplib.IMAP4_SSL) -> int:
            uids_to_mark = []

            # 1. Specific UIDs provided
            if email_ids and email_ids.strip():
                raw_ids = [i.strip() for i in email_ids.split(",") if i.strip()]
                uids_to_mark = [i.encode("utf-8") for i in raw_ids]

            # 2. Targeted query provided
            elif query and query.strip():
                clean_q = _escape_xgmraw_query(query.strip())
                status, data = mail.uid("search", None, f'X-GM-RAW "is:unread {clean_q}"')
                if status != "OK":
                    status, data = mail.uid("search", None, "UNSEEN", "TEXT", f'"{clean_q}"')
                if status == "OK" and data and data[0]:
                    uids_to_mark = data[0].split()

            # 3. Mark all unread (default)
            else:
                status, data = mail.uid("search", None, "UNSEEN")
                if status == "OK" and data and data[0]:
                    uids_to_mark = data[0].split()

            if not uids_to_mark:
                return 0

            total_marked = len(uids_to_mark)
            chunk_size = 250
            for i in range(0, total_marked, chunk_size):
                chunk = b",".join(uids_to_mark[i : i + chunk_size])
                mail.uid("store", chunk, "+FLAGS", "(\\Seen)")
            return total_marked

        total_marked = _IMAP_SESSION.run(email_addr, app_pwd, _op, select_inbox=True)
        if total_marked == 0:
            target_desc = f"matching '{query}'" if query else "in your inbox"
            return f"No unread emails found {target_desc}. You are already caught up!"

        if query:
            return (
                f"[SUCCESS] Successfully marked {total_marked} unread email(s) matching '{query}' as read.\n\n"
                f"[AIDEN: Let the user know in your witty style that those emails are now marked as read.]"
            )
        elif email_ids:
            return (
                f"[SUCCESS] Successfully marked {total_marked} email(s) as read.\n\n"
                f"[AIDEN: Let the user know those specific emails are marked as read.]"
            )
        else:
            return (
                f"[SUCCESS] Inbox Zero achieved! Successfully marked all {total_marked} unread emails as read.\n\n"
                f"[AIDEN: Celebrate Inbox Zero with the user in your signature cheerful, sassy style!]"
            )

    except Exception as e:
        return f"Error marking emails as read: {str(e)}"


def gmail_archive_email(email_ids: str | None = None, query: str | None = None) -> str:
    """
    Archives one or more emails from the user's Gmail inbox.
    Removes the INBOX label while safely preserving the email in 'All Mail'.
    Accepts specific email UIDs (comma-separated) or a search query.
    """
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    try:
        def _op(mail: imaplib.IMAP4_SSL) -> int:
            uids_to_archive = []

            # 1. Specific UIDs provided
            if email_ids and email_ids.strip():
                raw_ids = [i.strip() for i in email_ids.split(",") if i.strip()]
                uids_to_archive = [i.encode("utf-8") for i in raw_ids]

            # 2. Targeted search query provided
            elif query and query.strip():
                clean_q = _escape_xgmraw_query(query.strip())
                status, data = mail.uid("search", None, f'X-GM-RAW "is:inbox {clean_q}"')
                if status != "OK":
                    status, data = mail.uid("search", None, "TEXT", f'"{clean_q}"')
                if status == "OK" and data and data[0]:
                    uids_to_archive = data[0].split()

            if not uids_to_archive:
                return 0

            total_archived = len(uids_to_archive)
            chunk_size = 250
            for i in range(0, total_archived, chunk_size):
                chunk = b",".join(uids_to_archive[i : i + chunk_size])
                mail.uid("store", chunk, "-X-GM-LABELS", "(\\Inbox)")
                mail.uid("store", chunk, "+FLAGS", "(\\Deleted)")

            mail.expunge()
            return total_archived

        total_archived = _IMAP_SESSION.run(email_addr, app_pwd, _op, select_inbox=True)
        if total_archived == 0:
            target_desc = f"matching '{query}'" if query else f"with ID(s) '{email_ids}'"
            return f"No emails found {target_desc} in your inbox to archive."

        if query:
            return (
                f"[SUCCESS] Successfully archived {total_archived} email(s) matching '{query}' from your inbox.\n"
                f"They are safely preserved in your 'All Mail' archive.\n\n"
                f"[AIDEN: Let the user know those emails were archived cleanly.]"
            )
        else:
            return (
                f"[SUCCESS] Successfully archived {total_archived} email(s) from your inbox.\n"
                f"They are safely stored in your 'All Mail' archive.\n\n"
                f"[AIDEN: Confirm the emails have been archived from the inbox.]"
            )

    except Exception as e:
        return f"Error archiving email(s): {str(e)}"


# ---------------------------------------------------------------------------
# Master Tool Registry Map
# ---------------------------------------------------------------------------

GMAIL_TOOLS = {
    "gmail_list_unread_emails": gmail_list_unread_emails,
    "gmail_search_emails": gmail_search_emails,
    "gmail_read_email": gmail_read_email,
    "gmail_draft_email": gmail_draft_email,
    "gmail_send_email": gmail_send_email,
    "gmail_reply_email": gmail_reply_email,
    "gmail_mark_emails_as_read": gmail_mark_emails_as_read,
    "gmail_archive_email": gmail_archive_email,
}


# ---------------------------------------------------------------------------
# OpenAI Tool Schemas (Direct RAM injection)
# ---------------------------------------------------------------------------

GMAIL_TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "gmail_list_unread_emails",
            "description": "Lists recent unread emails from the user's Gmail inbox with subject, sender, date, preview snippet, and permanent UID, returning a ::gmail-card[...]:: tag. Summarize conversationally and always embed the card tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of unread emails to retrieve (default is 5, max 15).",
                    }
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_search_emails",
            "description": "Searches the user's Gmail inbox using keywords, sender name or email (e.g., 'from:amazon'), or subject (e.g., 'subject:receipt'). Returns matching email summaries with their permanent UIDs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search term, sender, or subject to look for (e.g. 'Amazon delivery', 'from:boss@company.com', 'invoice').",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of matching emails to retrieve (default is 5).",
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
            "name": "gmail_read_email",
            "description": "Fetches and reads the full body text and metadata of a specific email using its permanent UID, returning a card template. Synthesize an executive 1-2 sentence human summary and always embed the ::gmail-card[...]:: tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "email_id": {
                        "type": "string",
                        "description": "The permanent UID of the email to read (e.g., '7921').",
                    },
                    "mark_as_read": {
                        "type": "boolean",
                        "description": "Whether to mark the email as read in Gmail (defaults to False to avoid un-notifying the user without consent).",
                    },
                },
                "required": ["email_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_draft_email",
            "description": "Creates a draft email in the user's Gmail Drafts folder without sending it immediately. Use this when the user asks to compose, write, or prepare an email for later review.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_email": {
                        "type": "string",
                        "description": "The recipient's email address.",
                    },
                    "subject": {
                        "type": "string",
                        "description": "The subject line of the email.",
                    },
                    "body": {
                        "type": "string",
                        "description": "The full text content of the email.",
                    },
                    "cc": {
                        "type": "string",
                        "description": "Optional CC recipient email address.",
                    },
                },
                "required": ["to_email", "subject", "body"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_send_email",
            "description": "Sends an email immediately to a recipient from the user's Gmail account and saves a copy in their Sent Mail folder. Use when the user explicitly instructs to send an email.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_email": {
                        "type": "string",
                        "description": "The recipient's email address.",
                    },
                    "subject": {
                        "type": "string",
                        "description": "The subject line of the email.",
                    },
                    "body": {
                        "type": "string",
                        "description": "The full text content of the email.",
                    },
                    "cc": {
                        "type": "string",
                        "description": "Optional CC recipient email address.",
                    },
                },
                "required": ["to_email", "subject", "body"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_reply_email",
            "description": "Sends a direct threaded reply to an existing email by its permanent UID. Automatically formats 'Re:' subject line and preserves email threading.",
            "parameters": {
                "type": "object",
                "properties": {
                    "email_id": {
                        "type": "string",
                        "description": "The permanent UID of the email being replied to.",
                    },
                    "body": {
                        "type": "string",
                        "description": "The reply message content to send.",
                    },
                    "reply_all": {
                        "type": "boolean",
                        "description": "Whether to reply to all participants in CC as well (default is False).",
                    },
                },
                "required": ["email_id", "body"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_mark_emails_as_read",
            "description": "Marks unread emails in the user's Gmail inbox as read. Use this when the user asks to mark all emails as read ('inbox zero'), clear unread notifications, or mark specific unread emails or senders as read.",
            "parameters": {
                "type": "object",
                "properties": {
                    "all_unread": {
                        "type": "boolean",
                        "description": "Set to True to mark ALL unread emails in the inbox as read (default True).",
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional search query to only mark matching unread emails (e.g., 'Canva', 'from:google', 'newsletters').",
                    },
                    "email_ids": {
                        "type": "string",
                        "description": "Optional comma-separated list of specific email UIDs to mark as read (e.g., '7921, 7823').",
                    },
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_archive_email",
            "description": "Archives one or more emails from the user's Gmail inbox by removing them from the inbox while safely preserving them in All Mail. Accepts specific email_ids (comma-separated UIDs) or a search query (e.g. 'Canva', 'from:google').",
            "parameters": {
                "type": "object",
                "properties": {
                    "email_ids": {
                        "type": "string",
                        "description": "Optional comma-separated list of permanent email UIDs to archive (e.g. '7921').",
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional search term or sender to archive all matching emails from the inbox (e.g. 'newsletter', 'from:marketing@engage.canva.com').",
                    },
                },
                "additionalProperties": False,
            },
        },
    },
]
