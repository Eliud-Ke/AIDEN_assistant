"""
Windows Settings URI routing map.
Replaces settings_registry.json to eliminate disk reads.
"""

SETTINGS_SCHEMA = {
    "system": {"aliases": ["system", "system settings"], "target": "ms-settings:system"},
    "bluetooth": {"aliases": ["bluetooth", "bluetooth and devices", "devices"], "target": "ms-settings:bluetooth"},
    "network": {"aliases": ["network", "network and internet", "internet"], "target": "ms-settings:network"},
    "personalization": {"aliases": ["personalization", "appearance"], "target": "ms-settings:personalization"},
    "apps": {"aliases": ["apps", "installed apps", "programs"], "target": "ms-settings:appsfeatures"},
    "accounts": {"aliases": ["accounts", "user accounts"], "target": "ms-settings:emailandaccounts"},
    "time and language": {"aliases": ["time and language", "time", "language"], "target": "ms-settings:dateandtime"},
    "gaming": {"aliases": ["gaming", "game mode", "xbox settings"], "target": "ms-settings:gaming-gamebar"},
    "accessibility": {"aliases": ["accessibility", "ease of access"], "target": "ms-settings:easeofaccess"},
    "windows update": {"aliases": ["windows update", "update", "updates"], "target": "ms-settings:windowsupdate"},
    "privacy": {"aliases": ["privacy", "privacy and security", "security settings"], "target": "ms-settings:privacy"},

    "display": {"aliases": ["display", "screen", "monitor"], "target": "ms-settings:display"},
    "advanced display": {"aliases": ["advanced display", "refresh rate", "hz"], "target": "ms-settings:display-advanced"},
    "sound": {"aliases": ["sound", "audio", "volume", "speakers", "mic"], "target": "ms-settings:sound"},
    "power": {"aliases": ["power", "battery", "power and battery", "sleep"], "target": "ms-settings:powersleep"},
    "about": {"aliases": ["about", "pc info", "system info"], "target": "ms-settings:about"},
    "activation": {"aliases": ["activation", "windows key", "product key"], "target": "ms-settings:activation"},

    "mobile devices": {"aliases": ["mobile devices", "phone", "phone link"], "target": "ms-settings:mobile-devices"},

    "advanced network": {"aliases": ["advanced network", "advanced network settings", "adapter options"], "target": "ms-settings:network-advancedsettings"},
    "hotspot": {"aliases": ["hotspot", "mobile hotspot", "tethering"], "target": "ms-settings:network-mobilehotspot"},
    "wifi": {"aliases": ["wifi", "wi-fi", "wireless"], "target": "ms-settings:network-wifi"},

    "background": {"aliases": ["background", "wallpaper"], "target": "ms-settings:personalization-background"},
    "colors": {"aliases": ["colors", "colours", "dark mode", "light mode"], "target": "ms-settings:colors"},
    "theme": {"aliases": ["theme", "themes"], "target": "ms-settings:themes"},
    "lockscreen": {"aliases": ["lockscreen", "lock screen"], "target": "ms-settings:lockscreen"},
    "taskbar": {"aliases": ["taskbar"], "target": "ms-settings:taskbar"},

    "your info": {"aliases": ["your info", "profile picture"], "target": "ms-settings:yourinfo"},
    "sign in": {"aliases": ["sign in options", "hello", "pin", "password"], "target": "ms-settings:signinoptions"},
    "passkeys": {"aliases": ["passkeys", "security keys"], "target": "ms-settings:passkeys"},

    "region": {"aliases": ["region", "language and region"], "target": "ms-settings:regionlanguage"},

    "windows security": {"aliases": ["windows security", "defender", "antivirus", "virus protection"], "target": "windowsdefender:"},
    "main settings": {"aliases": ["settings", "settings app", "control panel"], "target": "ms-settings:"}
}


def get_setting_identifiers() -> list:
    """Extracts all valid settings keys and aliases into a flat list."""
    identifiers = set()
    for setting_key, setting_info in SETTINGS_SCHEMA.items():
        identifiers.add(setting_key.lower())
        for alias in setting_info.get("aliases", []):
            identifiers.add(alias.lower())
    return list(identifiers)
