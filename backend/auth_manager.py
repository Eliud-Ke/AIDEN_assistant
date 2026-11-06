import keyring
import os
import sys
import json
import secrets
import webbrowser
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
import requests
from dotenv import load_dotenv

# Automatically load backend/.env if present
_env_candidates = [
    os.path.join(os.path.dirname(__file__), ".env"),
    os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"),
]
for _ep in _env_candidates:
    if os.path.isfile(_ep):
        load_dotenv(_ep)
        break

# Ensure PyInstaller bundles and activates Windows Credential Manager backend
try:
    import keyring.backends.Windows
    keyring.set_keyring(keyring.backends.Windows.WinVaultKeyring())
except Exception:
    pass

SERVICE_NAME = "AidenAssistant_Auth"
KEY_NAME = "openai_api_key"
GROQ_KEY_NAME = "groq_api_key"

GMAIL_SERVICE_NAME = "AidenAssistant_Gmail"
GMAIL_EMAIL_KEY = "email_address"
GMAIL_PASSWORD_KEY = "app_password"

CALENDAR_SERVICE_NAME = "AidenAssistant_Calendar"
CALENDAR_REFRESH_TOKEN_KEY = "refresh_token"
CALENDAR_USER_EMAIL_KEY = "user_email"
CALENDAR_CUSTOM_CLIENT_ID_KEY = "custom_client_id"
CALENDAR_CUSTOM_CLIENT_SECRET_KEY = "custom_client_secret"

SPOTIFY_SERVICE_NAME = "AidenAssistant_Spotify"
SPOTIFY_REFRESH_TOKEN_KEY = "refresh_token"
SPOTIFY_USER_DISPLAY_NAME_KEY = "user_display_name"
SPOTIFY_USER_EMAIL_KEY = "user_email"
SPOTIFY_PRODUCT_KEY = "product_type"
SPOTIFY_CUSTOM_CLIENT_ID_KEY = "custom_client_id"
SPOTIFY_CUSTOM_CLIENT_SECRET_KEY = "custom_client_secret"


def save_api_key(api_key: str):
    """Securely encrypts and saves the API key to the Windows Credential Manager."""
    if not api_key:
        return
    keyring.set_password(SERVICE_NAME, KEY_NAME, api_key.strip())
    print("✅ [AUTH] API Key encrypted and saved to Windows Credential Manager.")


def get_api_key() -> str:
    """Retrieves and decrypts the API key from the OS vault."""
    return keyring.get_password(SERVICE_NAME, KEY_NAME)


def delete_api_key():
    """Removes the API key completely from the system."""
    try:
        keyring.delete_password(SERVICE_NAME, KEY_NAME)
        print("🗑️ [AUTH] API Key securely wiped from system.")
    except keyring.errors.PasswordDeleteError:
        pass


def save_groq_api_key(api_key: str):
    """Securely encrypts and saves the Groq API key to the Windows Credential Manager."""
    if not api_key:
        return
    keyring.set_password(SERVICE_NAME, GROQ_KEY_NAME, api_key.strip())
    print("✅ [AUTH] Groq API Key encrypted and saved to Windows Credential Manager.")


def get_groq_api_key() -> str:
    """Retrieves the Groq API key from OS vault or GROQ_API_KEY env var."""
    val = keyring.get_password(SERVICE_NAME, GROQ_KEY_NAME)
    if val:
        return val.strip()
    return os.environ.get("GROQ_API_KEY", "").strip()


def save_gmail_credentials(email: str, app_password: str):
    """Securely saves Gmail address and 16-character App Password to Windows Credential Manager."""
    email_clean = email.strip().lower()
    pwd_clean = app_password.strip().replace(" ", "")
    keyring.set_password(GMAIL_SERVICE_NAME, GMAIL_EMAIL_KEY, email_clean)
    keyring.set_password(GMAIL_SERVICE_NAME, GMAIL_PASSWORD_KEY, pwd_clean)
    print("✅ [GMAIL AUTH] Gmail credentials encrypted and saved to Windows Credential Manager.")


def get_gmail_credentials() -> tuple[str, str]:
    """Retrieves Gmail address and App Password from the OS vault."""
    email = keyring.get_password(GMAIL_SERVICE_NAME, GMAIL_EMAIL_KEY) or ""
    pwd = keyring.get_password(GMAIL_SERVICE_NAME, GMAIL_PASSWORD_KEY) or ""
    return email.strip(), pwd.strip()


def delete_gmail_credentials():
    """Removes Gmail credentials completely from the system."""
    try:
        keyring.delete_password(GMAIL_SERVICE_NAME, GMAIL_EMAIL_KEY)
    except Exception:
        pass
    try:
        keyring.delete_password(GMAIL_SERVICE_NAME, GMAIL_PASSWORD_KEY)
    except Exception:
        pass
    print("🗑️ [GMAIL AUTH] Gmail credentials securely wiped from system.")


def save_calendar_client_credentials(client_id: str, client_secret: str):
    """Saves custom Google Cloud OAuth client credentials to Windows Credential Manager."""
    cid_clean = client_id.strip()
    sec_clean = client_secret.strip()
    if not cid_clean or not sec_clean:
        return
    keyring.set_password(CALENDAR_SERVICE_NAME, CALENDAR_CUSTOM_CLIENT_ID_KEY, cid_clean)
    keyring.set_password(CALENDAR_SERVICE_NAME, CALENDAR_CUSTOM_CLIENT_SECRET_KEY, sec_clean)
    print("✅ [CALENDAR AUTH] Custom OAuth client credentials saved to Windows Credential Manager.")


def get_custom_calendar_client_credentials() -> tuple[str, str]:
    """Retrieves custom Google Cloud OAuth client credentials from the OS vault."""
    cid = keyring.get_password(CALENDAR_SERVICE_NAME, CALENDAR_CUSTOM_CLIENT_ID_KEY) or ""
    sec = keyring.get_password(CALENDAR_SERVICE_NAME, CALENDAR_CUSTOM_CLIENT_SECRET_KEY) or ""
    return cid.strip(), sec.strip()


def delete_custom_calendar_client_credentials():
    """Removes custom client credentials from the OS vault."""
    try:
        keyring.delete_password(CALENDAR_SERVICE_NAME, CALENDAR_CUSTOM_CLIENT_ID_KEY)
    except Exception:
        pass
    try:
        keyring.delete_password(CALENDAR_SERVICE_NAME, CALENDAR_CUSTOM_CLIENT_SECRET_KEY)
    except Exception:
        pass
    print("🗑️ [CALENDAR AUTH] Custom OAuth client credentials removed.")


def load_calendar_client_credentials() -> tuple[str, str, str]:
    """
    Finds the active Google OAuth client credentials.
    Priority:
    1. Custom client credentials stored in Windows Credential Manager.
    2. Local `credentials.json` file in backend/ or app root.
    Returns: (client_id, client_secret, source) where source is 'custom', 'file', or 'none'.
    """
    # 1. Check custom vault
    cid, sec = get_custom_calendar_client_credentials()
    if cid and sec:
        return cid, sec, "custom"

    # 2. Check credentials.json
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "credentials.json"),
        os.path.join(os.getcwd(), "credentials.json"),
        os.path.join(os.getcwd(), "backend", "credentials.json"),
    ]
    if getattr(sys, "frozen", False):
        base_dir = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
        candidates.insert(0, os.path.join(base_dir, "credentials.json"))
        candidates.insert(1, os.path.join(os.path.dirname(sys.executable), "credentials.json"))

    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                info = data.get("installed") or data.get("web") or data
                file_cid = (info.get("client_id") or "").strip()
                file_sec = (info.get("client_secret") or "").strip()
                if file_cid and file_sec:
                    return file_cid, file_sec, "file"
            except Exception:
                continue

    return "", "", "none"


def save_calendar_user_tokens(refresh_token: str, user_email: str = ""):
    """Securely stores user OAuth refresh token and associated email in Windows Credential Manager."""
    if refresh_token:
        keyring.set_password(CALENDAR_SERVICE_NAME, CALENDAR_REFRESH_TOKEN_KEY, refresh_token.strip())
    if user_email:
        keyring.set_password(CALENDAR_SERVICE_NAME, CALENDAR_USER_EMAIL_KEY, user_email.strip().lower())
    print("✅ [CALENDAR AUTH] User OAuth tokens saved to Windows Credential Manager.")


def get_calendar_user_tokens() -> tuple[str, str]:
    """Retrieves user OAuth refresh token and email from the OS vault."""
    token = keyring.get_password(CALENDAR_SERVICE_NAME, CALENDAR_REFRESH_TOKEN_KEY) or ""
    email = keyring.get_password(CALENDAR_SERVICE_NAME, CALENDAR_USER_EMAIL_KEY) or ""
    return token.strip(), email.strip()


def delete_calendar_user_tokens():
    """Removes user Google Calendar tokens from the system."""
    try:
        keyring.delete_password(CALENDAR_SERVICE_NAME, CALENDAR_REFRESH_TOKEN_KEY)
    except Exception:
        pass
    try:
        keyring.delete_password(CALENDAR_SERVICE_NAME, CALENDAR_USER_EMAIL_KEY)
    except Exception:
        pass
    print("🗑️ [CALENDAR AUTH] Google Calendar user tokens wiped.")


def get_calendar_status() -> dict:
    """Returns comprehensive authentication status for Google Calendar."""
    refresh_token, email = get_calendar_user_tokens()
    cid, sec, source = load_calendar_client_credentials()
    custom_cid, custom_sec = get_custom_calendar_client_credentials()

    has_token = bool(refresh_token)
    has_client = bool(cid and sec)

    return {
        "ok": True,
        "has_token": has_token,
        "has_client_config": has_client,
        "email": email if has_token else "",
        "client_source": source,
        "has_custom_credentials": bool(custom_cid and custom_sec),
        "custom_client_id": (custom_cid[:16] + "...") if len(custom_cid) > 16 else custom_cid,
    }


def run_calendar_oauth_flow(port: int = 8766, timeout: int = 120) -> dict:
    """
    Executes a temporary loopback HTTP server and opens user's browser
    to complete the Google Calendar OAuth 2.0 consent flow.
    """
    client_id, client_secret, source = load_calendar_client_credentials()
    if not client_id or not client_secret:
        return {
            "ok": False,
            "error": "No Google Cloud OAuth credentials found. Please drop credentials.json in backend/ or configure Custom Client Credentials in Settings.",
        }

    redirect_uri = f"http://localhost:{port}"
    state_token = secrets.token_urlsafe(16)
    scopes = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email"

    auth_params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": scopes,
        "access_type": "offline",
        "prompt": "consent",
        "state": state_token,
    }
    auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(auth_params)}"

    auth_code_result = {"code": None, "error": None}

    class OAuthCallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return  # Suppress default server console logging

        def do_GET(self):
            parsed_url = urlparse(self.path)
            query = parse_qs(parsed_url.query)

            if "error" in query:
                err_msg = query["error"][0]
                auth_code_result["error"] = err_msg
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                html_denied = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Aiden - Authorization Denied</title>
  <style>
    body { background: #f3ede1; color: #1a1917; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: rgba(255, 255, 255, 0.7); border: 1px solid rgba(0,0,0,0.06); border-radius: 20px; padding: 40px 36px; text-align: center; max-width: 380px; box-shadow: 0 16px 36px rgba(60, 50, 40, 0.08); backdrop-filter: blur(16px); }
    h2 { color: #dc2626; font-size: 22px; margin-top: 0; font-weight: 600; letter-spacing: -0.02em; }
    p { font-size: 14px; color: #6b6862; line-height: 1.5; margin: 12px 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Access Denied</h2>
    <p>Google Calendar authorization was not granted. You can safely close this browser window.</p>
  </div>
</body>
</html>"""
                self.wfile.write(html_denied.encode("utf-8"))
                return

            if "code" in query:
                received_state = query.get("state", [""])[0]
                if received_state != state_token:
                    auth_code_result["error"] = "State token mismatch (CSRF warning)"
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"State mismatch error.")
                    return

                code = query["code"][0]
                auth_code_result["code"] = code

                # Pre-exchange token to obtain authenticated email for the success screen
                user_email = ""
                token_data = None
                try:
                    token_res = requests.post(
                        "https://oauth2.googleapis.com/token",
                        data={
                            "client_id": client_id,
                            "client_secret": client_secret,
                            "code": code,
                            "grant_type": "authorization_code",
                            "redirect_uri": redirect_uri,
                        },
                        headers={"Accept": "application/json"},
                        timeout=15,
                    )
                    if token_res.status_code == 200:
                        token_data = token_res.json()
                        auth_code_result["token_data"] = token_data
                        acc_token = token_data.get("access_token")
                        if acc_token:
                            u_res = requests.get(
                                "https://www.googleapis.com/oauth2/v2/userinfo",
                                headers={"Authorization": f"Bearer {acc_token}"},
                                timeout=10,
                            )
                            if u_res.status_code == 200:
                                user_email = u_res.json().get("email", "")
                except Exception as ex:
                    print(f"⚠️ [CALENDAR OAUTH] Pre-exchange notice: {ex}")

                auth_code_result["email"] = user_email

                # Load polished luxury template with inlined 3D assets
                template_path = Path(__file__).parent / "templates" / "calendar_connected.html"
                if template_path.exists():
                    html_raw = template_path.read_text(encoding="utf-8")
                    display_email = user_email if user_email else "Google account"
                    html_success = html_raw.replace("{{USER_EMAIL}}", display_email)
                else:
                    html_success = f"""<!DOCTYPE html><html><body style='background:#f3ede1;color:#1a1917;font-family:sans-serif;text-align:center;padding-top:20vh;'><h1>Calendar connected</h1><p>{user_email or 'Google account'} connected</p></body></html>"""

                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(html_success.encode("utf-8"))
                return

            self.send_response(404)
            self.end_headers()

    server = HTTPServer(("127.0.0.1", port), OAuthCallbackHandler)
    server.timeout = timeout

    print(f"🌐 [CALENDAR OAUTH] Opening browser for authorization at {redirect_uri}...")
    webbrowser.open(auth_url)

    # Wait for callback
    while auth_code_result["code"] is None and auth_code_result["error"] is None:
        server.handle_request()
        if server.timeout and server.timeout <= 0:
            break

    server.server_close()

    if auth_code_result["error"]:
        return {"ok": False, "error": f"Authorization error: {auth_code_result['error']}"}

    code = auth_code_result["code"]
    if not code:
        return {"ok": False, "error": "Authorization timed out or was cancelled by user."}

    # Process tokens and finalize user credentials
    try:
        token_data = auth_code_result.get("token_data")
        user_email = auth_code_result.get("email", "")

        # Fallback exchange if pre-exchange did not complete
        if not token_data:
            token_res = requests.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code": code,
                    "grant_type": "authorization_code",
                    "redirect_uri": redirect_uri,
                },
                headers={"Accept": "application/json"},
                timeout=15,
            )
            if token_res.status_code != 200:
                return {
                    "ok": False,
                    "error": f"Failed to exchange token with Google: {token_res.text}",
                }
            token_data = token_res.json()

        new_refresh = token_data.get("refresh_token")
        access_token = token_data.get("access_token")

        existing_refresh, existing_email = get_calendar_user_tokens()
        final_refresh = new_refresh or existing_refresh

        if not final_refresh:
            return {
                "ok": False,
                "error": "Google did not return a refresh token. Try revoking app permissions and connecting again.",
            }

        if not user_email:
            user_email = existing_email
            if access_token:
                try:
                    user_res = requests.get(
                        "https://www.googleapis.com/oauth2/v2/userinfo",
                        headers={"Authorization": f"Bearer {access_token}"},
                        timeout=10,
                    )
                    if user_res.status_code == 200:
                        user_email = user_res.json().get("email", existing_email)
                except Exception:
                    pass

        save_calendar_user_tokens(final_refresh, user_email)
        return {
            "ok": True,
            "message": "Connected successfully!",
            "email": user_email,
        }

    except Exception as e:
        return {"ok": False, "error": f"Token processing failed: {str(e)}"}


# ---------------------------------------------------------------------------
# Spotify Authentication & Credentials
# ---------------------------------------------------------------------------

def save_spotify_client_credentials(client_id: str, client_secret: str):
    """Securely saves custom Spotify developer credentials to Windows Credential Manager."""
    cid_clean = client_id.strip()
    sec_clean = client_secret.strip()
    keyring.set_password(SPOTIFY_SERVICE_NAME, SPOTIFY_CUSTOM_CLIENT_ID_KEY, cid_clean)
    keyring.set_password(SPOTIFY_SERVICE_NAME, SPOTIFY_CUSTOM_CLIENT_SECRET_KEY, sec_clean)
    print("✅ [SPOTIFY AUTH] Custom client credentials saved to Windows Credential Manager.")


def get_custom_spotify_client_credentials() -> tuple[str, str]:
    """Retrieves custom Spotify client credentials from OS vault."""
    cid = keyring.get_password(SPOTIFY_SERVICE_NAME, SPOTIFY_CUSTOM_CLIENT_ID_KEY) or ""
    sec = keyring.get_password(SPOTIFY_SERVICE_NAME, SPOTIFY_CUSTOM_CLIENT_SECRET_KEY) or ""
    return cid.strip(), sec.strip()


def delete_custom_spotify_client_credentials():
    """Removes custom Spotify credentials from the OS vault."""
    try:
        keyring.delete_password(SPOTIFY_SERVICE_NAME, SPOTIFY_CUSTOM_CLIENT_ID_KEY)
    except Exception:
        pass
    try:
        keyring.delete_password(SPOTIFY_SERVICE_NAME, SPOTIFY_CUSTOM_CLIENT_SECRET_KEY)
    except Exception:
        pass
    print("🗑️ [SPOTIFY AUTH] Custom Spotify client credentials removed.")


def load_spotify_client_credentials() -> tuple[str, str, str]:
    """
    Finds the active Spotify OAuth client credentials.
    Priority:
    1. Custom client credentials stored in Windows Credential Manager.
    2. Environment variables / .env (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET).
    3. Local spotify_credentials.json file.
    Returns: (client_id, client_secret, source) where source is 'custom', 'env', 'file', or 'none'.
    """
    # 1. Custom vault
    cid, sec = get_custom_spotify_client_credentials()
    if cid and sec:
        return cid, sec, "custom"

    # 2. Environment variables (.env)
    env_cid = (os.environ.get("SPOTIFY_CLIENT_ID") or "").strip()
    env_sec = (os.environ.get("SPOTIFY_CLIENT_SECRET") or "").strip()
    if env_cid and env_sec:
        return env_cid, env_sec, "env"

    # 3. Optional spotify_credentials.json file
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "spotify_credentials.json"),
        os.path.join(os.getcwd(), "spotify_credentials.json"),
        os.path.join(os.getcwd(), "backend", "spotify_credentials.json"),
    ]
    if getattr(sys, "frozen", False):
        base_dir = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
        candidates.insert(0, os.path.join(base_dir, "spotify_credentials.json"))
        candidates.insert(1, os.path.join(os.path.dirname(sys.executable), "spotify_credentials.json"))

    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                file_cid = (data.get("client_id") or "").strip()
                file_sec = (data.get("client_secret") or "").strip()
                if file_cid and file_sec:
                    return file_cid, file_sec, "file"
            except Exception:
                continue

    return "", "", "none"


def save_spotify_user_tokens(refresh_token: str, display_name: str = "", email: str = "", product: str = "premium"):
    """Securely stores user Spotify OAuth refresh token, display name, and product type."""
    if refresh_token:
        keyring.set_password(SPOTIFY_SERVICE_NAME, SPOTIFY_REFRESH_TOKEN_KEY, refresh_token.strip())
    if display_name:
        keyring.set_password(SPOTIFY_SERVICE_NAME, SPOTIFY_USER_DISPLAY_NAME_KEY, display_name.strip())
    if email:
        keyring.set_password(SPOTIFY_SERVICE_NAME, SPOTIFY_USER_EMAIL_KEY, email.strip().lower())
    if product:
        keyring.set_password(SPOTIFY_SERVICE_NAME, SPOTIFY_PRODUCT_KEY, product.strip().lower())
    print("✅ [SPOTIFY AUTH] User Spotify tokens saved to Windows Credential Manager.")


def get_spotify_user_tokens() -> dict:
    """Retrieves user Spotify tokens and profile from the OS vault."""
    refresh_token = (keyring.get_password(SPOTIFY_SERVICE_NAME, SPOTIFY_REFRESH_TOKEN_KEY) or "").strip()
    display_name = (keyring.get_password(SPOTIFY_SERVICE_NAME, SPOTIFY_USER_DISPLAY_NAME_KEY) or "").strip()
    email = (keyring.get_password(SPOTIFY_SERVICE_NAME, SPOTIFY_USER_EMAIL_KEY) or "").strip()
    product = (keyring.get_password(SPOTIFY_SERVICE_NAME, SPOTIFY_PRODUCT_KEY) or "").strip()
    return {
        "refresh_token": refresh_token,
        "display_name": display_name,
        "email": email,
        "product": product,
    }


def delete_spotify_user_tokens():
    """Removes user Spotify tokens from the system."""
    for key in [SPOTIFY_REFRESH_TOKEN_KEY, SPOTIFY_USER_DISPLAY_NAME_KEY, SPOTIFY_USER_EMAIL_KEY, SPOTIFY_PRODUCT_KEY]:
        try:
            keyring.delete_password(SPOTIFY_SERVICE_NAME, key)
        except Exception:
            pass
    print("🗑️ [SPOTIFY AUTH] Spotify user tokens wiped.")


def get_spotify_status() -> dict:
    """Returns comprehensive authentication status for Spotify."""
    tokens = get_spotify_user_tokens()
    cid, sec, source = load_spotify_client_credentials()
    custom_cid, custom_sec = get_custom_spotify_client_credentials()

    has_token = bool(tokens["refresh_token"])
    has_client = bool(cid and sec)

    return {
        "ok": True,
        "has_token": has_token,
        "has_client_config": has_client,
        "display_name": tokens["display_name"] if has_token else "",
        "email": tokens["email"] if has_token else "",
        "product": tokens["product"] if has_token else "",
        "client_source": source,
        "has_custom_credentials": bool(custom_cid and custom_sec),
        "custom_client_id": (custom_cid[:16] + "...") if len(custom_cid) > 16 else custom_cid,
    }


def get_spotify_access_token() -> str | None:
    """Refreshes and returns a valid Bearer access token using stored refresh token."""
    tokens = get_spotify_user_tokens()
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        return None

    cid, sec, _ = load_spotify_client_credentials()
    if not cid or not sec:
        return None

    import base64
    auth_header = base64.b64encode(f"{cid}:{sec}".encode("utf-8")).decode("utf-8")
    try:
        res = requests.post(
            "https://accounts.spotify.com/api/token",
            headers={
                "Authorization": f"Basic {auth_header}",
                "Content-Type": "application/x-www-form-urlencoded"
            },
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token
            },
            timeout=10
        )
        if res.status_code == 200:
            data = res.json()
            if "refresh_token" in data:
                save_spotify_user_tokens(data["refresh_token"], tokens.get("display_name", ""), tokens.get("email", ""), tokens.get("product", ""))
            return data.get("access_token")
        else:
            print(f"⚠️ [SPOTIFY AUTH] Token refresh failed: {res.status_code} {res.text}")
            return None
    except Exception as e:
        print(f"⚠️ [SPOTIFY AUTH] Token refresh error: {e}")
        return None


def run_spotify_oauth_flow(port: int = 8888, timeout: int = 120) -> dict:
    """
    Executes a temporary loopback HTTP server and opens user's browser
    to complete the Spotify OAuth 2.0 authorization code flow.
    """
    import base64

    client_id, client_secret, source = load_spotify_client_credentials()
    if not client_id or not client_secret:
        return {
            "ok": False,
            "error": "No Spotify Developer credentials found. Configure Custom Client Credentials in Settings or set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in backend/.env.",
        }

    redirect_uri = f"http://127.0.0.1:{port}/callback"
    state_token = secrets.token_urlsafe(16)
    scopes = (
        "user-modify-playback-state "
        "user-read-playback-state "
        "user-read-currently-playing "
        "user-library-read "
        "playlist-read-private "
        "playlist-read-collaborative "
        "user-read-email "
        "user-read-private"
    )

    auth_params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": scopes,
        "state": state_token,
        "show_dialog": "true",
    }
    auth_url = f"https://accounts.spotify.com/authorize?{urlencode(auth_params)}"

    auth_code_result = {"code": None, "error": None}

    class SpotifyOAuthCallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return  # Suppress console logging

        def do_GET(self):
            parsed_url = urlparse(self.path)
            query = parse_qs(parsed_url.query)

            if "error" in query:
                err_msg = query["error"][0]
                auth_code_result["error"] = err_msg
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                html_denied = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Aiden - Authorization Denied</title>
  <style>
    body { background: #f3ede1; color: #1a1917; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: rgba(255, 255, 255, 0.7); border: 1px solid rgba(0,0,0,0.06); border-radius: 20px; padding: 40px 36px; text-align: center; max-width: 380px; box-shadow: 0 16px 36px rgba(60, 50, 40, 0.08); backdrop-filter: blur(16px); }
    h2 { color: #dc2626; font-size: 22px; margin-top: 0; font-weight: 600; letter-spacing: -0.02em; }
    p { font-size: 14px; color: #6b6862; line-height: 1.5; margin: 12px 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Access Denied</h2>
    <p>Spotify authorization was not granted. You can safely close this browser window.</p>
  </div>
</body>
</html>"""
                self.wfile.write(html_denied.encode("utf-8"))
                return

            if "code" in query:
                received_state = query.get("state", [""])[0]
                if received_state != state_token:
                    auth_code_result["error"] = "State token mismatch (CSRF warning)"
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"State mismatch error.")
                    return

                code = query["code"][0]
                auth_code_result["code"] = code

                # Pre-exchange token to obtain authenticated user profile for the success screen
                display_name = ""
                user_tier = "PREMIUM"
                token_data = None
                try:
                    auth_header = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("utf-8")
                    token_res = requests.post(
                        "https://accounts.spotify.com/api/token",
                        headers={
                            "Authorization": f"Basic {auth_header}",
                            "Content-Type": "application/x-www-form-urlencoded"
                        },
                        data={
                            "grant_type": "authorization_code",
                            "code": code,
                            "redirect_uri": redirect_uri
                        },
                        timeout=15
                    )
                    if token_res.status_code == 200:
                        token_data = token_res.json()
                        auth_code_result["token_data"] = token_data
                        acc_token = token_data.get("access_token")
                        if acc_token:
                            me_res = requests.get(
                                "https://api.spotify.com/v1/me",
                                headers={"Authorization": f"Bearer {acc_token}"},
                                timeout=10
                            )
                            if me_res.status_code == 200:
                                me_json = me_res.json()
                                display_name = me_json.get("display_name", "") or me_json.get("id", "")
                                auth_code_result["display_name"] = display_name
                                auth_code_result["user_email"] = me_json.get("email", "")
                                prod = me_json.get("product", "free").upper()
                                auth_code_result["product_type"] = prod
                                user_tier = prod
                except Exception as ex:
                    print(f"⚠️ [SPOTIFY OAUTH] Pre-exchange notice: {ex}")

                # Load polished luxury template with inlined 3D assets
                template_path = Path(__file__).parent / "templates" / "spotify_connected.html"
                if template_path.exists():
                    html_raw = template_path.read_text(encoding="utf-8")
                    display_user = display_name if display_name else "Spotify User"
                    html_success = html_raw.replace("{{USER_DISPLAY}}", display_user).replace("{{USER_TIER}}", user_tier)
                else:
                    html_success = f"""<!DOCTYPE html><html><body style='background:#f3ede1;color:#1a1917;font-family:sans-serif;text-align:center;padding-top:20vh;'><h1>Spotify connected</h1><p>{display_name or 'Spotify User'} connected</p></body></html>"""

                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(html_success.encode("utf-8"))
                return

            self.send_response(404)
            self.end_headers()

    server = HTTPServer(("127.0.0.1", port), SpotifyOAuthCallbackHandler)
    server.timeout = timeout

    print(f"🌐 [SPOTIFY OAUTH] Opening browser for authorization at {redirect_uri}...")
    webbrowser.open(auth_url)

    while auth_code_result["code"] is None and auth_code_result["error"] is None:
        server.handle_request()
        if server.timeout and server.timeout <= 0:
            break

    server.server_close()

    if auth_code_result["error"]:
        return {"ok": False, "error": f"Authorization error: {auth_code_result['error']}"}

    code = auth_code_result["code"]
    if not code:
        return {"ok": False, "error": "Authorization timed out or was cancelled by user."}

    # Exchange code for tokens (or reuse pre-exchanged tokens)
    try:
        token_data = auth_code_result.get("token_data")
        display_name = auth_code_result.get("display_name", "")
        user_email = auth_code_result.get("user_email", "")
        product_type = auth_code_result.get("product_type", "free").lower()

        if not token_data:
            auth_header = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("utf-8")
            token_res = requests.post(
                "https://accounts.spotify.com/api/token",
                headers={
                    "Authorization": f"Basic {auth_header}",
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri
                },
                timeout=15
            )
            if token_res.status_code != 200:
                return {"ok": False, "error": f"Token exchange failed ({token_res.status_code}): {token_res.text}"}
            token_data = token_res.json()

        refresh_token = token_data.get("refresh_token")
        access_token = token_data.get("access_token")

        if not refresh_token:
            return {"ok": False, "error": "Spotify did not return a refresh token."}

        if not display_name and access_token:
            try:
                me_res = requests.get(
                    "https://api.spotify.com/v1/me",
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=10
                )
                if me_res.status_code == 200:
                    me_json = me_res.json()
                    display_name = me_json.get("display_name", "") or me_json.get("id", "")
                    user_email = me_json.get("email", "")
                    product_type = me_json.get("product", "free").lower()
            except Exception as me_err:
                print(f"⚠️ [SPOTIFY AUTH] Could not read user profile: {me_err}")

        save_spotify_user_tokens(refresh_token, display_name, user_email, product_type)

        return {
            "ok": True,
            "message": "Spotify connected successfully!",
            "display_name": display_name,
            "email": user_email,
            "product": product_type,
        }

    except Exception as e:
        return {"ok": False, "error": f"Spotify authentication exchange failed: {str(e)}"}


def ensure_api_key() -> str:
    """
    Checks if a key exists. If not, intercepts the boot process and 
    asks the user for it (only when running in an interactive terminal).
    """
    key = get_api_key()
    if not key:
        if sys.stdin and hasattr(sys.stdin, "isatty") and sys.stdin.isatty():
            print("\n🔐 [AUTH REQUIRED] AIDEN cannot wake up without an OpenAI API Key.")
            print("Your key will be encrypted and stored securely in your Windows Credential Manager.")
            try:
                key = input(
                    "Paste your OpenAI API key (sk-...) and press Enter: ").strip()
                save_api_key(key)
            except EOFError:
                return ""
        else:
            print("⚠️ [AUTH] No OpenAI API key found in Windows Credential Manager.")
            return ""
    return key


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if "--save-stdin" in sys.argv:
        try:
            raw_key = sys.stdin.read().strip()
            if not raw_key:
                print(json.dumps({"ok": False, "error": "API key cannot be empty."}))
                sys.exit(1)
            keyring.set_password(SERVICE_NAME, KEY_NAME, raw_key)
            print(json.dumps({"ok": True, "message": "API Key encrypted and saved to Windows Credential Manager."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--check" in sys.argv:
        try:
            existing = get_api_key()
            has_key = bool(existing and existing.strip())
            print(json.dumps({"ok": True, "has_key": has_key}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "has_key": False, "error": str(e)}))
            sys.exit(1)

    elif "--save-gmail-stdin" in sys.argv:
        try:
            raw_input = sys.stdin.read().strip()
            data = json.loads(raw_input)
            email = str(data.get("email", "")).strip()
            pwd = str(data.get("app_password", "")).strip().replace(" ", "")
            if not email or not pwd:
                print(json.dumps({"ok": False, "error": "Email and App Password cannot be empty."}))
                sys.exit(1)
            save_gmail_credentials(email, pwd)
            print(json.dumps({"ok": True, "message": "Gmail credentials saved to Windows Credential Manager."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--get-gmail" in sys.argv:
        try:
            email, pwd = get_gmail_credentials()
            has_creds = bool(email and pwd)
            print(json.dumps({"ok": True, "has_credentials": has_creds, "email": email if has_creds else ""}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "has_credentials": False, "email": "", "error": str(e)}))
            sys.exit(1)

    elif "--delete-gmail" in sys.argv:
        try:
            delete_gmail_credentials()
            print(json.dumps({"ok": True, "message": "Gmail credentials removed."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--get-calendar" in sys.argv:
        try:
            status = get_calendar_status()
            print(json.dumps(status))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "has_token": False, "has_client_config": False, "error": str(e)}))
            sys.exit(1)

    elif "--calendar-oauth" in sys.argv:
        try:
            res = run_calendar_oauth_flow()
            print(json.dumps(res))
            sys.exit(0 if res.get("ok") else 1)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--save-calendar-client-stdin" in sys.argv:
        try:
            raw_input = sys.stdin.read().strip()
            data = json.loads(raw_input)
            # Support either {"client_id": "...", "client_secret": "..."} or raw credentials.json
            info = data.get("installed") or data.get("web") or data
            cid = str(info.get("client_id", "")).strip()
            sec = str(info.get("client_secret", "")).strip()
            if not cid or not sec:
                print(json.dumps({"ok": False, "error": "Client ID and Client Secret cannot be empty."}))
                sys.exit(1)
            save_calendar_client_credentials(cid, sec)
            print(json.dumps({"ok": True, "message": "Custom credentials saved to Windows Credential Manager."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--delete-calendar" in sys.argv:
        try:
            delete_calendar_user_tokens()
            print(json.dumps({"ok": True, "message": "Calendar user tokens removed."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--delete-calendar-client" in sys.argv:
        try:
            delete_custom_calendar_client_credentials()
            print(json.dumps({"ok": True, "message": "Custom client credentials removed."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--get-spotify" in sys.argv:
        try:
            status = get_spotify_status()
            print(json.dumps(status))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "has_token": False, "has_client_config": False, "error": str(e)}))
            sys.exit(1)

    elif "--spotify-oauth" in sys.argv:
        try:
            res = run_spotify_oauth_flow()
            print(json.dumps(res))
            sys.exit(0 if res.get("ok") else 1)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--save-spotify-client-stdin" in sys.argv:
        try:
            raw_input = sys.stdin.read().strip()
            data = json.loads(raw_input)
            cid = str(data.get("client_id", "")).strip()
            sec = str(data.get("client_secret", "")).strip()
            if not cid or not sec:
                print(json.dumps({"ok": False, "error": "Client ID and Client Secret cannot be empty."}))
                sys.exit(1)
            save_spotify_client_credentials(cid, sec)
            print(json.dumps({"ok": True, "message": "Custom Spotify credentials saved to Windows Credential Manager."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--disconnect-spotify" in sys.argv:
        try:
            delete_spotify_user_tokens()
            print(json.dumps({"ok": True, "message": "Spotify user tokens removed."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--delete-spotify-client" in sys.argv:
        try:
            delete_custom_spotify_client_credentials()
            print(json.dumps({"ok": True, "message": "Custom Spotify client credentials removed."}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)
