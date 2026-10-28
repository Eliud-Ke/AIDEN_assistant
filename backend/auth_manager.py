import keyring
import os
import sys
import json

# Ensure PyInstaller bundles and activates Windows Credential Manager backend
try:
    import keyring.backends.Windows
    keyring.set_keyring(keyring.backends.Windows.WinVaultKeyring())
except Exception:
    pass

SERVICE_NAME = "AidenAssistant_Auth"
KEY_NAME = "openai_api_key"

GMAIL_SERVICE_NAME = "AidenAssistant_Gmail"
GMAIL_EMAIL_KEY = "email_address"
GMAIL_PASSWORD_KEY = "app_password"


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
