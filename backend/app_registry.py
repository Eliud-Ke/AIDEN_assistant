import json
import re
import subprocess
import threading

# ---------------------------------------------------------
# IN-MEMORY REGISTRY STORAGE
# ---------------------------------------------------------
_registry_lock = threading.Lock()
_master_apps: dict = {}
_cached_identifiers: list = []


def clean_app_name(name: str) -> str:
    """Cleans up raw display names into natural voice keys."""
    if not name:
        return ""
    clean = re.sub(r"[®™//]", "", name)
    clean = re.sub(
        r"www\..*?\.(com|org|net|ph|co\.ke)-[A-Z0-9]+", "", clean, flags=re.IGNORECASE
    )
    clean = re.sub(r"\.exe$", "", clean, flags=re.IGNORECASE)
    return clean.strip()


def scan_all_apps() -> dict:
    """Executes the master PowerShell command to fetch all OS apps."""
    ps_command = """
    $startApps = Get-StartApps | Select-Object @{N='Name';E={$_.Name}}, @{N='Target';E={$_.AppID}}, @{N='Type';E={if ($_.AppID -like "*!*") {"UWP/PWA"} else {"Win32/Shortcut"}}}
    
    $registryApps = Get-ChildItem "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths", "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths" -ErrorAction SilentlyContinue | 
        ForEach-Object { 
            $path = (Get-ItemProperty $_.PSPath).'(default)'
            if ($path) {
                [PSCustomObject]@{
                    Name = $_.PSChildName.Replace('.exe','')
                    Target = $path
                    Type = "Registry Executable"
                }
            }
        }
        
    ($startApps + $registryApps) | Sort-Object Name -Unique | ConvertTo-Json -Compress
    """

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_command],
            capture_output=True,
            text=True,
            check=True
        )

        if not result.stdout.strip():
            return {}

        raw_apps = json.loads(result.stdout)
        if isinstance(raw_apps, dict):
            raw_apps = [raw_apps]

        app_map = {}

        for item in raw_apps:
            raw_name = item.get("Name", "")
            target = item.get("Target", "")
            app_type = item.get("Type", "")

            if not raw_name or not target:
                continue

            clean_name = clean_app_name(raw_name)
            key_name = clean_name.lower()
            aliases = list(set([key_name, raw_name.lower()]))

            app_map[key_name] = {
                "display_name": clean_name,
                "type": app_type,
                "target": target,
                "aliases": aliases
            }

        print(f"🔄 [APP REGISTRY] Discovered {len(app_map)} apps in memory.")
        return app_map

    except Exception as e:
        print(f"⚠️ [APP REGISTRY] Failed to scan apps: {e}")
        return {}


def update_registry():
    """Background updater to refresh apps directly in RAM."""
    global _master_apps, _cached_identifiers
    live_apps = scan_all_apps()

    # Build the flat identifier list (all app keys + all aliases)
    identifiers = set()
    for app_key, app_info in live_apps.items():
        identifiers.add(app_key)
        for alias in app_info.get("aliases", []):
            identifiers.add(alias)

    with _registry_lock:
        _master_apps = live_apps
        _cached_identifiers = list(identifiers)

    print("✅ [APP REGISTRY] App list updated in RAM.")


def get_all_app_identifiers() -> list:
    """Returns a simple flat list of all valid app names and aliases."""
    with _registry_lock:
        return list(_cached_identifiers)


def get_app_target(app_name: str):
    """Used by tool_registry to launch the app: matches against keys or aliases."""
    target_clean = app_name.lower().strip()
    with _registry_lock:
        # Direct match
        if target_clean in _master_apps:
            return _master_apps[target_clean]

        # Alias lookup
        for _, app_info in _master_apps.items():
            if target_clean in app_info.get("aliases", []):
                return app_info
    return None


if __name__ == "__main__":
    update_registry()
    print("Identifiers count:", len(get_all_app_identifiers()))
