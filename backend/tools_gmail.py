"""
AIDEN GMAIL CONNECTOR TOOLS
Handles direct IMAP & SMTP communication with Gmail via Google App Passwords.
Zero external pip dependencies (uses Python standard libraries: imaplib, smtplib, email).
Credentials fetched on-demand from Windows Credential Manager via auth_manager.
All operations use permanent IMAP UIDs (Unique Identifiers) for rock-solid stability.
"""

import email
import html
import imaplib
import re
import smtplib
import time
from email.header import decode_header
from email.message import EmailMessage
from email.policy import default

from auth_manager import get_gmail_credentials

GMAIL_IMAP_HOST = "imap.gmail.com"
GMAIL_IMAP_PORT = 993
GMAIL_SMTP_HOST = "smtp.gmail.com"
GMAIL_SMTP_PORT = 465

NOT_CONNECTED_MSG = (
    "Gmail is not connected yet. Please add your Gmail address and 16-character Google App Password "
    "in the bottom tray under Settings -> Authentication -> Gmail Connector."
)


# ---------------------------------------------------------------------------
# Internal Helpers
# ---------------------------------------------------------------------------

def _get_credentials() -> tuple[str, str]:
    """Retrieves Gmail credentials or raises ValueError if missing."""
    email_addr, app_pwd = get_gmail_credentials()
    if not email_addr or not app_pwd:
        raise ValueError(NOT_CONNECTED_MSG)
    return email_addr, app_pwd


def _connect_imap(email_addr: str, app_pwd: str) -> imaplib.IMAP4_SSL:
    """Establishes an authenticated IMAP SSL connection to Gmail."""
    try:
        mail = imaplib.IMAP4_SSL(GMAIL_IMAP_HOST, GMAIL_IMAP_PORT, timeout=20)
        mail.login(email_addr, app_pwd)
        return mail
    except imaplib.IMAP4.error as e:
        raise ValueError(f"Gmail IMAP Authentication failed: {str(e)}. Verify your Google App Password.")
    except Exception as e:
        raise ValueError(f"Could not connect to Gmail IMAP: {str(e)}")


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
    """Lists recent unread emails from user's Gmail inbox using permanent UIDs."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    try:
        mail = _connect_imap(email_addr, app_pwd)
        mail.select("INBOX", readonly=True)

        status, data = mail.uid("search", None, "UNSEEN")
        if status != "OK" or not data or not data[0]:
            mail.logout()
            return "You have no unread emails in your inbox right now. Everything is caught up!"

        email_uids = data[0].split()
        total_unread = len(email_uids)
        # Take the most recent up to max_results (newest UIDs are at the end)
        recent_uids = email_uids[-max_results:]
        recent_uids.reverse()

        summaries = []
        for uid in recent_uids:
            uid_str = uid.decode("utf-8")
            status, fetch_data = mail.uid(
                "fetch",
                uid,
                "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[1]<0.350>)"
            )
            if status != "OK":
                continue

            headers_raw = b""
            body_preview = ""
            for item in fetch_data:
                if isinstance(item, tuple):
                    if b"HEADER.FIELDS" in item[0]:
                        headers_raw = item[1]
                    elif b"BODY" in item[0]:
                        body_preview = item[1].decode("utf-8", errors="replace")

            msg_header = email.message_from_bytes(headers_raw)
            subject = _decode_mime_header(msg_header.get("Subject", "(No Subject)"))
            sender = _decode_mime_header(msg_header.get("From", "Unknown Sender"))
            date = msg_header.get("Date", "")

            # Clean snippet
            clean_snippet = _clean_html_text(body_preview).replace("\n", " ")
            clean_snippet = re.sub(r"Content-(Type|Transfer-Encoding|Disposition):[^\n;]+(;[^\n]+)?", " ", clean_snippet, flags=re.IGNORECASE)
            clean_snippet = re.sub(r'boundary="?[^"\s]+"?', " ", clean_snippet, flags=re.IGNORECASE)
            clean_snippet = re.sub(r"--[a-zA-Z0-9_-]+", " ", clean_snippet)
            clean_snippet = re.sub(r"<meta[^>]*>", " ", clean_snippet, flags=re.IGNORECASE)
            clean_snippet = re.sub(r"\s+", " ", clean_snippet).strip()
            if len(clean_snippet) > 160:
                clean_snippet = clean_snippet[:157] + "..."

            summaries.append(
                f"* [ID: {uid_str}] From: {sender}\n"
                f"  Date: {date}\n"
                f"  Subject: {subject}\n"
                f"  Preview: {clean_snippet or '(No preview available)'}"
            )

        mail.logout()

        return (
            f"=== GMAIL: {total_unread} UNREAD EMAILS (Showing latest {len(summaries)}) ===\n"
            + "\n\n".join(summaries)
            + "\n\n[AIDEN: Summarize these to the user. Offer to read, reply, archive, or mark as read by ID.]"
        )

    except Exception as e:
        return f"Error retrieving unread emails: {str(e)}"


def gmail_search_emails(query: str, max_results: int = 5) -> str:
    """Searches the user's Gmail inbox using keywords, sender, or subject, returning permanent UIDs."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    if not query or not query.strip():
        return "Search query cannot be empty."

    query = query.strip()

    try:
        mail = _connect_imap(email_addr, app_pwd)
        mail.select("INBOX", readonly=True)

        # Try Gmail native X-GM-RAW search first (supports from:..., subject:..., etc.)
        status, data = mail.uid("search", None, f'X-GM-RAW "{query}"')
        if status != "OK" or not data or not data[0]:
            # Fallback to standard IMAP TEXT search
            status, data = mail.uid("search", None, "TEXT", f'"{query}"')

        if status != "OK" or not data or not data[0]:
            mail.logout()
            return f"No emails found matching query: \"{query}\"."

        email_uids = data[0].split()
        total_found = len(email_uids)
        recent_uids = email_uids[-max_results:]
        recent_uids.reverse()

        summaries = []
        for uid in recent_uids:
            uid_str = uid.decode("utf-8")
            status, fetch_data = mail.uid("fetch", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            if status != "OK":
                continue

            headers_raw = b""
            for item in fetch_data:
                if isinstance(item, tuple) and b"HEADER.FIELDS" in item[0]:
                    headers_raw = item[1]

            msg_header = email.message_from_bytes(headers_raw)
            subject = _decode_mime_header(msg_header.get("Subject", "(No Subject)"))
            sender = _decode_mime_header(msg_header.get("From", "Unknown Sender"))
            date = msg_header.get("Date", "")

            summaries.append(
                f"* [ID: {uid_str}] From: {sender}\n"
                f"  Date: {date}\n"
                f"  Subject: {subject}"
            )

        mail.logout()

        return (
            f"=== GMAIL SEARCH: \"{query}\" ({total_found} found, showing latest {len(summaries)}) ===\n"
            + "\n\n".join(summaries)
            + "\n\n[AIDEN: Present these search results to the user and offer to read, archive, or reply to any specific ID.]"
        )

    except Exception as e:
        return f"Error searching emails for \"{query}\": {str(e)}"


def gmail_read_email(email_id: str, mark_as_read: bool = False) -> str:
    """Reads the full content of an email by its permanent UID."""
    try:
        email_addr, app_pwd = _get_credentials()
    except ValueError as e:
        return str(e)

    if not email_id or not str(email_id).strip():
        return "Please provide a valid email_id to read."

    clean_id = str(email_id).strip()

    try:
        mail = _connect_imap(email_addr, app_pwd)
        mail.select("INBOX", readonly=not mark_as_read)

        fetch_cmd = "(RFC822)" if mark_as_read else "(BODY.PEEK[])"
        status, data = mail.uid("fetch", clean_id.encode("utf-8"), fetch_cmd)
        if status != "OK" or not data or not data[0]:
            mail.logout()
            return f"Could not find email with ID '{clean_id}'. It may have been archived or deleted."

        raw_bytes = b""
        for item in data:
            if isinstance(item, tuple) and len(item) > 1:
                raw_bytes = item[1]
                break

        msg = email.message_from_bytes(raw_bytes, policy=default)
        subject = _decode_mime_header(msg.get("Subject", "(No Subject)"))
        sender = _decode_mime_header(msg.get("From", "Unknown Sender"))
        to_addr = _decode_mime_header(msg.get("To", ""))
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

        mail.logout()

        return (
            f"=== GMAIL MESSAGE [ID: {clean_id}] ===\n"
            f"From: {sender}\n"
            f"To: {to_addr}\n"
            f"Date: {date}\n"
            f"Subject: {subject}\n"
            f"Attachments: {att_str}\n"
            f"Message-ID: {message_id}\n\n"
            f"--- CONTENT ---\n"
            f"{body}{truncated_note}\n\n"
            f"[AIDEN: Summarize or deliver this email to the user with your signature charm. Offer to reply or archive it if appropriate.]"
        )

    except Exception as e:
        return f"Error reading email ID {clean_id}: {str(e)}"


def gmail_draft_email(to_email: str, subject: str, body: str, cc: str | None = None) -> str:
    """Creates a draft email in the user's Gmail Drafts folder without sending it."""
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

        mail = _connect_imap(email_addr, app_pwd)
        drafts_folder = _find_folder(mail, "\\Drafts", "[Gmail]/Drafts")

        # Append to Drafts with \Draft flag
        mail.select(drafts_folder)
        status, _ = mail.append(
            drafts_folder,
            "(\\Draft)",
            imaplib.Time2Internaldate(time.time()),
            msg.as_bytes()
        )
        mail.logout()

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
    """Sends an email immediately via Gmail SMTP and saves a copy to Sent Mail."""
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

        # 1. Send via Gmail SSL SMTP
        with smtplib.SMTP_SSL(GMAIL_SMTP_HOST, GMAIL_SMTP_PORT, timeout=25) as smtp:
            smtp.login(email_addr, app_pwd)
            smtp.send_message(msg)

        # 2. Append copy to [Gmail]/Sent Mail so it appears in the user's Sent box
        try:
            mail = _connect_imap(email_addr, app_pwd)
            sent_folder = _find_folder(mail, "\\Sent", "[Gmail]/Sent Mail")
            mail.append(
                sent_folder,
                "(\\Seen)",
                imaplib.Time2Internaldate(time.time()),
                msg.as_bytes()
            )
            mail.logout()
        except Exception:
            pass

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
        # 1. Fetch original email headers via UID
        mail = _connect_imap(email_addr, app_pwd)
        mail.select("INBOX", readonly=True)

        status, data = mail.uid(
            "fetch",
            clean_id.encode("utf-8"),
            "(BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT MESSAGE-ID REFERENCES)])"
        )
        if status != "OK" or not data or not data[0]:
            mail.logout()
            return f"Could not find original email with ID '{clean_id}' to reply to."

        headers_raw = b""
        for item in data:
            if isinstance(item, tuple) and len(item) > 1:
                headers_raw = item[1]
                break

        mail.logout()

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

        # 2. Send via SMTP
        with smtplib.SMTP_SSL(GMAIL_SMTP_HOST, GMAIL_SMTP_PORT, timeout=25) as smtp:
            smtp.login(email_addr, app_pwd)
            smtp.send_message(reply)

        # 3. Save copy to Sent folder
        try:
            mail = _connect_imap(email_addr, app_pwd)
            sent_folder = _find_folder(mail, "\\Sent", "[Gmail]/Sent Mail")
            mail.append(
                sent_folder,
                "(\\Seen)",
                imaplib.Time2Internaldate(time.time()),
                reply.as_bytes()
            )
            mail.logout()
        except Exception:
            pass

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
        mail = _connect_imap(email_addr, app_pwd)
        mail.select("INBOX", readonly=False)

        uids_to_mark = []

        # 1. Specific UIDs provided
        if email_ids and email_ids.strip():
            raw_ids = [i.strip() for i in email_ids.split(",") if i.strip()]
            uids_to_mark = [i.encode("utf-8") for i in raw_ids]

        # 2. Targeted query provided
        elif query and query.strip():
            clean_q = query.strip()
            status, data = mail.uid("search", None, f'X-GM-RAW "is:unread {clean_q}"')
            if status != "OK" or not data or not data[0]:
                status, data = mail.uid("search", None, "UNSEEN", "TEXT", f'"{clean_q}"')
            if status == "OK" and data and data[0]:
                uids_to_mark = data[0].split()

        # 3. Mark all unread (default)
        else:
            status, data = mail.uid("search", None, "UNSEEN")
            if status == "OK" and data and data[0]:
                uids_to_mark = data[0].split()

        if not uids_to_mark:
            mail.logout()
            target_desc = f"matching '{query}'" if query else "in your inbox"
            return f"No unread emails found {target_desc}. You are already caught up!"

        total_marked = len(uids_to_mark)

        # Batch update via UID store
        chunk_size = 250
        for i in range(0, total_marked, chunk_size):
            chunk = b",".join(uids_to_mark[i : i + chunk_size])
            mail.uid("store", chunk, "+FLAGS", "(\\Seen)")

        mail.logout()

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
        mail = _connect_imap(email_addr, app_pwd)
        mail.select("INBOX", readonly=False)

        uids_to_archive = []

        # 1. Specific UIDs provided
        if email_ids and email_ids.strip():
            raw_ids = [i.strip() for i in email_ids.split(",") if i.strip()]
            uids_to_archive = [i.encode("utf-8") for i in raw_ids]

        # 2. Targeted search query provided
        elif query and query.strip():
            clean_q = query.strip()
            status, data = mail.uid("search", None, f'X-GM-RAW "is:inbox {clean_q}"')
            if status != "OK" or not data or not data[0]:
                status, data = mail.uid("search", None, "TEXT", f'"{clean_q}"')
            if status == "OK" and data and data[0]:
                uids_to_archive = data[0].split()

        if not uids_to_archive:
            mail.logout()
            target_desc = f"matching '{query}'" if query else f"with ID(s) '{email_ids}'"
            return f"No emails found {target_desc} in your inbox to archive."

        total_archived = len(uids_to_archive)

        # Batch archive: remove from INBOX view while keeping in All Mail
        chunk_size = 250
        for i in range(0, total_archived, chunk_size):
            chunk = b",".join(uids_to_archive[i : i + chunk_size])
            # Google Mail IMAP Extension: -X-GM-LABELS (\Inbox) removes the Inbox label
            mail.uid("store", chunk, "-X-GM-LABELS", "(\\Inbox)")
            mail.uid("store", chunk, "+FLAGS", "(\\Deleted)")

        mail.expunge()
        mail.logout()

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
            "description": "Lists recent unread emails from the user's Gmail inbox with subject, sender, date, preview snippet, and permanent UID. Use this when the user asks about new, recent, or unread emails.",
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
            "description": "Fetches and reads the full body text and attachment details of a specific email using its permanent UID (obtained from search or list_unread).",
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
