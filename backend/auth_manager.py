import keyring
import os
import sys
import json

SERVICE_NAME = "AidenAssistant_Auth"
KEY_NAME = "openai_api_key"


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
