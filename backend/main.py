import sys
import multiprocessing

# Ensure Windows stdout/stderr handles UTF-8 cleanly
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

if __name__ == "__main__":
    multiprocessing.freeze_support()
    # Fast-path CLI dispatcher for standalone PyInstaller binary (--cli-module <name> [flags...])
    if len(sys.argv) >= 3 and sys.argv[1] == "--cli-module":
        target_module = sys.argv[2]
        sys.argv = [sys.argv[0]] + sys.argv[3:]
        import runpy
        runpy.run_module(target_module, run_name="__main__", alter_sys=True)
        sys.exit(0)

from auth_manager import ensure_api_key, get_api_key
from openai import AsyncOpenAI
import threading
import time
import asyncio
import json
import re
import os
import concurrent.futures
from core_schema import CORE_TOOLS_SCHEMA, get_core_tool_names
from connectors import CONNECTORS_SCHEMA, get_connector_tool_names, resolve_connector_key
connectors_registry_schema = CONNECTORS_SCHEMA
from settings_schema import get_setting_identifiers

# ⚡ Core Modules (In-Memory Refactored)
from configuration import config
from ans import system_ans, run_ans
from app_registry import update_registry, get_all_app_identifiers
import memory_manager
from wake_word import start_wake_word_engine
from shortcut_detector import init_shortcut_detector, get_shortcut_detector
import server

try:
    import msvcrt
except ImportError:
    msvcrt = None

IS_INTERACTIVE_TTY = bool(
    msvcrt and sys.stdin and hasattr(sys.stdin, "isatty") and sys.stdin.isatty()
)

# ⚡ GLOBAL THREAD COORDINATION (WAKE WORD, SHORTCUT & SLEEP ENGINE) ⚡
wake_word_event = threading.Event()
shortcut_wake_event = threading.Event()
shortcut_sleep_event = threading.Event()
assistant_busy_event = threading.Event()
stop_event = threading.Event()

# ⚡ Import custom tool registry
try:
    import tool_registry
except ImportError:
    tool_registry = None

# 1. SETUP & AUTH
SECURE_API_KEY = ensure_api_key()
brain_client = AsyncOpenAI(api_key=SECURE_API_KEY or "missing-key")

# ⚡ GLOBAL CONNECTOR TRACKER ⚡
active_connectors = set()
active_turn_connectors = set()


def get_connector_for_tool(func_name: str, args: dict = None) -> str:
    """Returns canonical connector key (e.g. 'gmail') for a tool, or empty string."""
    if func_name == "connect_service":
        raw = (args or {}).get("service_name") or (args or {}).get("service") or ""
        return resolve_connector_key(raw)
    if func_name.startswith("gmail_"):
        return "gmail"
    if func_name.startswith("spotify_"):
        return "spotify"
    if func_name.startswith("calendar_"):
        return "google_calendar"
    if func_name.startswith("notes_") or func_name.startswith("obsidian_"):
        return "notes_vault"
    if func_name.startswith("youtube_"):
        return "youtube_visual"
    if func_name.startswith("file_"):
        return "file_system"
    return ""

# ⚡ THE STATUS DICTIONARY (Minimalist Text Only)
TOOL_STATUS_MAP = {
    # System Hardware & Settings
    "get_system_telemetry": "CHECKING VITALS",
    "get_active_windows": "SCANNING SCREEN",
    "set_system_brightness": "ADJUSTING BRIGHTNESS",
    "manage_system_power": "SYSTEM OVERRIDE",
    "open_windows_setting": "OPENING SETTINGS",
    "manage_recycle_bin": "MANAGING RECYCLE BIN",

    # Utilities & OS Apps
    "get_current_time_date": "CHECKING CLOCK",
    "get_live_location": "ACQUIRING GPS",
    "get_weather_forecast": "CHECKING WEATHER",
    "get_bible_passage": "READING SCRIPTURE",
    "launch_app": "OPENING APP",
    "close_application": "CLOSING APP",
    "list_installed_apps": "SCANNING REGISTRY",
    "open_in_browser": "OPENING BROWSER",

    # Media & Volume (System Level)
    "get_currently_playing": "CHECKING MEDIA",
    "control_media_playback": "CONTROLLING MEDIA",
    "set_system_volume": "ADJUSTING VOLUME",

    # Web & Grounding
    "grounded_web_search": "SEARCHING THE WEB",

    # Gmail Connector Tools
    "gmail_list_unread_emails": "CHECKING UNREAD",
    "gmail_search_emails": "SEARCHING INBOX",
    "gmail_read_email": "READING EMAIL",
    "gmail_draft_email": "CREATING DRAFT",
    "gmail_send_email": "SENDING EMAIL",
    "gmail_reply_email": "REPLYING TO EMAIL",
    "gmail_mark_emails_as_read": "MARKING AS READ",
    "gmail_archive_email": "ARCHIVING EMAIL",

    # Google Calendar Connector Tools
    "calendar_get_agenda": "CHECKING AGENDA",
    "calendar_create_event": "SCHEDULING EVENT",
    "calendar_search_events": "SEARCHING CALENDAR",
    "calendar_update_event": "UPDATING EVENT",
    "calendar_delete_event": "CANCELING EVENT",
    "calendar_check_availability": "CHECKING SCHEDULE",

    # Spotify Connector Tools
    "spotify_check_active_device": "CHECKING DEVICES",
    "spotify_play": "STREAMING MUSIC",
    "spotify_pause": "PAUSING SPOTIFY",
    "spotify_next": "SKIPPING TRACK",
    "spotify_previous": "PREVIOUS TRACK",
    "spotify_get_current_playback": "CHECKING TRACK",
    "spotify_set_volume": "ADJUSTING VOLUME",
    "spotify_set_playback_mode": "UPDATING PLAYBACK",
    "spotify_save_track": "SAVING TRACK",
}

# ---------------------------------------------------------
# 1. UI EVENT BRIDGE & ROUTERS
# ---------------------------------------------------------


def get_all_valid_tool_identifiers():
    """Dynamically parses registries and RAM to extract all valid identifiers."""
    valid_identifiers = set()

    # 1. Parse Core Tools directly from RAM
    try:
        valid_identifiers.update(get_core_tool_names())
    except Exception as e:
        print(f"⚠️ [SYSTEM] Failed to load core tool identifiers: {e}")

    # 2. Parse Connectors directly from RAM
    try:
        valid_identifiers.update(get_connector_tool_names())
    except Exception as e:
        print(f"⚠️ [SYSTEM] Failed to load connector tool identifiers: {e}")

    # ⚡ 3. Instant RAM Lookup for Apps (Zero Disk I/O)
    try:
        valid_identifiers.update(get_all_app_identifiers())
    except Exception:
        pass

    # 4. Parse Settings directly from RAM
    try:
        valid_identifiers.update(get_setting_identifiers())
    except Exception as e:
        print(f"⚠️ [SYSTEM] Failed to load settings identifiers: {e}")

    return list(valid_identifiers)


# ---------------------------------------------------------
# 2. TOOL EXECUTION & INTERCEPTOR ENGINE (RESPONSES API)
# ---------------------------------------------------------

def to_responses_tools(tools_list: list) -> list:
    """Normalizes tool schemas into OpenAI Responses API flattened function format."""
    normalized = []
    for t in tools_list:
        if "function" in t and isinstance(t["function"], dict):
            fn = t["function"]
            normalized.append({
                "type": "function",
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
            })
        else:
            normalized.append(t)
    return normalized


def execute_and_intercept(tc_id, func_name, arguments_str):
    """Executes a single tool and formats Responses API function_call_output item."""
    try:
        args = json.loads(arguments_str) if arguments_str else {}
    except Exception:
        args = {}

    print(f"   ⚙ [WORKER] Executing: {func_name}({args})")

    conn_key = get_connector_for_tool(func_name, args)
    if conn_key:
        active_turn_connectors.add(conn_key)

    if func_name == "connect_service":
        raw_service = args.get("service_name") or args.get("service") or ""
        resolved_key = resolve_connector_key(raw_service)
        if resolved_key and CONNECTORS_SCHEMA.get(resolved_key, {}).get("tools"):
            if resolved_key not in active_connectors:
                print(f"   🔌 [MCP HANDSHAKE] Mounting connector stack: {resolved_key}")
                active_connectors.add(resolved_key)
                display_name = CONNECTORS_SCHEMA[resolved_key].get("display_name", resolved_key.upper())
                server.broadcast_ui_tag(f"CONNECTING TO {display_name.upper()}", connector=resolved_key)
                time.sleep(1.5)  # Deliberate 1500ms dwell time for natural connection perception

    try:
        if tool_registry and func_name in tool_registry.AVAILABLE_TOOLS:
            result = tool_registry.AVAILABLE_TOOLS[func_name](**args)
        else:
            result = f"Error: Tool {func_name} not found."
    except Exception as e:
        result = f"Error executing tool: {str(e)}"

    tool_result = str(result)
    print(
        f"   📥 [RESULT]: Data received from {func_name} (Length: {len(tool_result)} chars)")
    return {
        "type": "function_call_output",
        "call_id": tc_id,
        "output": tool_result,
        "_tool_name": func_name,
    }


# ---------------------------------------------------------
# 3. MAIN CORE LOGIC (HEADLESS TERMINAL & UI BRIDGE LOOP)
# ---------------------------------------------------------


def flush_console_buffer():
    """Drains any stray keystrokes (e.g., Spacebar from Win+Space) from the Windows console buffer."""
    if IS_INTERACTIVE_TTY and msvcrt:
        while msvcrt.kbhit():
            try:
                msvcrt.getwch()
            except Exception:
                break


async def async_input(prompt: str, sleep_event: threading.Event, stop_event: threading.Event):
    """
    Waits for a user command from either:
    1. The floating Chat Pill UI (via server.get_pending_ui_command())
    2. Interactive Windows console (without blocking asyncio)
    Exits immediately (< 30ms) if sleep_event or stop_event is set.
    """
    flush_console_buffer()
    print(prompt, end="", flush=True)
    buffer = []

    while not stop_event.is_set():
        if sleep_event.is_set():
            flush_console_buffer()
            return None

        # 1. Check WebSocket UI command queue first
        ui_cmd = server.get_pending_ui_command()
        if ui_cmd is not None:
            print(ui_cmd)
            return ui_cmd

        # 2. Check interactive terminal input if attached to a console
        if IS_INTERACTIVE_TTY and msvcrt and msvcrt.kbhit():
            ch = msvcrt.getwch()
            # Re-check if this keystroke was actually part of the sleep shortcut
            if sleep_event.is_set():
                flush_console_buffer()
                return None

            if ch in ('\r', '\n'):
                print()  # Move to next line
                return "".join(buffer)
            elif ch == '\x08':  # Backspace
                if buffer:
                    buffer.pop()
                    sys.stdout.write('\b \b')
                    sys.stdout.flush()
            elif ch in ('\x00', '\xe0'):
                # Arrow key or function key escape code
                try:
                    _ = msvcrt.getwch()
                except Exception:
                    pass
            elif ch == '\x03':  # Ctrl+C
                raise KeyboardInterrupt
            else:
                buffer.append(ch)
                sys.stdout.write(ch)
                sys.stdout.flush()

        await asyncio.sleep(0.03)

    return None


async def wait_for_wake_signal() -> str:
    """
    Asynchronously monitors for:
    1. Voice wake word detection via OpenWakeWord background thread.
    2. Physical keyboard shortcut (Windows + Space toggle).
    3. Application stop signal.
    """
    flush_console_buffer()
    while not stop_event.is_set():
        if wake_word_event.is_set():
            flush_console_buffer()
            return "voice"
        if shortcut_wake_event.is_set():
            flush_console_buffer()
            return "shortcut"
        await asyncio.sleep(0.05)
    return "stop"


async def main_loop():
    global active_connectors, SECURE_API_KEY, brain_client

    # ⚡ Start WebSocket UI Bridge on ws://127.0.0.1:8765
    server.init_bridge(shortcut_wake_event, shortcut_sleep_event, stop_event)
    try:
        await server.start_ws_server("127.0.0.1", 8765)
    except Exception as ws_err:
        print(f"⚠️ [WS BRIDGE] Failed to bind port 8765: {ws_err}")

    # ⚡ Load assembled persona from in-memory ConfigurationManager
    base_persona = config.get_assembled_persona()

    tool_registry_schema = CORE_TOOLS_SCHEMA

    connectors_registry_schema = CONNECTORS_SCHEMA

    # ⚡ Initial Long-Term Memory Load
    print(">> [SYSTEM] Loading long-term memory into RAM...")
    fresh_memory = memory_manager.get_memory_context()
    recent_episodes = memory_manager.get_recent_episodes(limit=10)
    static_system_rules = f"{base_persona}\n\n[LONG TERM FACTS]\n{fresh_memory}\n\n[PAST EPISODES]\n{recent_episodes}"

    chat_history = []      # Legacy Memory: Keeps the last 20 messages
    working_memory = []    # Native Memory: Multi-step OpenAI context
    session_history = []   # Current wake cycle tracker

    print("🟢 Boot Sequence: Core Logic Online (Dormant Sleep Mode).")

    # 💤 THE SLEEP ⟷ AWAKE MASTER STATE MACHINE
    while not stop_event.is_set():
        # Ensure dormant sleep state & yield mic to wake word engine
        assistant_busy_event.clear()
        wake_word_event.clear()
        shortcut_wake_event.clear()
        shortcut_sleep_event.clear()
        server.clear_pending_ui_commands()

        detector = get_shortcut_detector()
        if detector:
            detector.set_state("sleeping")

        # Broadcast SLEEP state to floating Chat Pill & Launcher UI
        await server.broadcast_state_async(is_awake=False)

        current_shortcut = config.prefs.wake_shortcut.upper()
        print("\n" + "=" * 60)
        print("💤 [AIDEN SLEEPING] Status: Dormant in RAM.")
        print("   🗣️ Say 'Aiden' into your mic to wake her up...")
        print(f"   ⌨️ Physical Shortcut: Press {current_shortcut} to wake/sleep")
        print("=" * 60 + "\n")

        wake_source = await wait_for_wake_signal()
        if wake_source == "stop" or stop_event.is_set():
            break

        # --- TRANSITION TO AWAKE ---
        assistant_busy_event.set()
        wake_word_event.clear()
        shortcut_wake_event.clear()
        shortcut_sleep_event.clear()

        if detector:
            detector.set_state("awake")

        mood = system_ans.state.get("current_mood", "Sassy, sharp, and witty.")
        print(f"\n⚡ [AIDEN AWAKE] Activated via {wake_source.upper()} trigger! Current Mood: {mood}")
        print("✨ [AIDEN]: I'm listening! What can I do for you?")
        print(f"💡 Press {current_shortcut} anytime to put Aiden back to sleep.\n")

        # Broadcast AWAKE state to slide up the floating Chat Pill UI
        await server.broadcast_state_async(is_awake=True, wake_source=wake_source, mood=mood)

        is_awake = True
        while is_awake and not stop_event.is_set():
            try:
                raw_command = await async_input("\n🟢 [YOU]: ", shortcut_sleep_event, stop_event)
            except (EOFError, KeyboardInterrupt):
                print("\n🛑 Shutting down AIDEN...")
                stop_event.set()
                break

            # ⚡ PHYSICAL SHORTCUT SLEEP TOGGLE ⚡
            if shortcut_sleep_event.is_set() or raw_command is None:
                shortcut_sleep_event.clear()
                print("\n💤 [SHORTCUT] Physical sleep toggle triggered. Entering Sleep Cycle...")
                await server.broadcast_state_async(is_awake=False)
                if session_history:
                    print(">> [SYSTEM] Consolidating session memory before sleep...")
                    memory_manager.trigger_consolidation(session_history)
                    session_history.clear()
                working_memory.clear()
                active_connectors.clear()

                base_persona = config.get_assembled_persona()
                fresh_memory = memory_manager.get_memory_context()
                recent_episodes = memory_manager.get_recent_episodes(limit=10)
                static_system_rules = f"{base_persona}\n\n[LONG TERM FACTS]\n{fresh_memory}\n\n[PAST EPISODES]\n{recent_episodes}"
                print("🟢 [SYSTEM] Memory consolidated. Aiden is now asleep.")
                is_awake = False
                break

            clean_command = raw_command.strip()
            if not clean_command:
                continue

            command = clean_command

            # Ensure fresh API key if updated from UI
            latest_key = get_api_key()
            if latest_key and latest_key != SECURE_API_KEY:
                SECURE_API_KEY = latest_key
                brain_client = AsyncOpenAI(api_key=SECURE_API_KEY)

            # --- STANDARD AI PROCESSING ---
            print(f"\n☁️ [OPENAI CLOUD] THINKING...")
            active_turn_connectors.clear()
            await server.broadcast_ui_tag_async("THINKING")

            try:
                # ⚡ DYNAMIC CONSCIOUSNESS READ (EVERY TURN) - Instant RAM Access
                try:
                    dynamic_consciousness = system_ans.get_consciousness_prompt()
                except Exception as e:
                    print(
                        f"⚠️ [SYSTEM] Failed to read RAM consciousness state: {e}")
                    dynamic_consciousness = "\n[CURRENT CONSCIOUSNESS STATE]\nMOOD: Sassy\n"

                # 1. Initialize Active Context Array with the FROZEN Vault
                messages = [{"role": "developer", "content": static_system_rules}]

                # 2. CLEAN WORKING MEMORY: Inject past turns
                if working_memory:
                    messages.extend(working_memory)

                # 3. THE TRIGGER (ANS Consciousness + Active Connectors prepended before User Request)
                ans_block = dynamic_consciousness.strip()
                active_conn_list = sorted(list(active_connectors))
                conn_status = f"[ACTIVE CONNECTORS]: {', '.join(active_conn_list) if active_conn_list else 'None'}"

                parts = []
                if ans_block:
                    parts.append(ans_block)
                parts.append(conn_status)
                parts.append(f"[USER REQUEST]\n{command}")
                user_payload = "\n\n".join(parts)
                new_user_msg = {"role": "user", "content": user_payload}
                messages.append(new_user_msg)

                # 4. THE SMART TRIMMER MARKER
                turn_start_index = len(messages) - 1

                # ⚡ THE AGENTIC SMART CHAIN LOOP (OPENAI RESPONSES API)
                max_turns = 15
                current_turn = 0
                last_response_id = None
                pending_tool_outputs = []

                while current_turn < max_turns:
                    if shortcut_sleep_event.is_set() or stop_event.is_set():
                        break

                    current_turn += 1
                    print(f"\n🧠 [BRAIN] Thinking (Turn {current_turn})...")

                    # ⚡ THE DYNAMIC MCP CONNECTOR MOUNTING ⚡
                    current_turn_tools = []
                    if tool_registry_schema:
                        raw_tools = list(tool_registry_schema)

                        for stack_name in sorted(active_connectors):
                            if connectors_registry_schema.get(stack_name, {}).get("tools"):
                                raw_tools.extend(
                                    connectors_registry_schema[stack_name]["tools"])

                        current_turn_tools = to_responses_tools(raw_tools)

                    # Construct stateful or initial Responses API payload
                    if current_turn == 1 or not last_response_id:
                        active_input = [
                            {k: v for k, v in m.items() if k != "_tool_name"}
                            for m in messages
                        ]
                        api_kwargs = {
                            "model": "gpt-5.6-luna",
                            "input": active_input,
                            "stream": True,
                            "temperature": 0.8,
                            "reasoning": {"effort": "none"},
                        }
                        if current_turn_tools:
                            api_kwargs["tools"] = current_turn_tools
                    else:
                        active_input = [
                            {
                                "type": "function_call_output",
                                "call_id": r["call_id"],
                                "output": r["output"],
                            }
                            for r in pending_tool_outputs
                        ]
                        api_kwargs = {
                            "model": "gpt-5.6-luna",
                            "previous_response_id": last_response_id,
                            "input": active_input,
                            "stream": True,
                            "temperature": 0.8,
                            "reasoning": {"effort": "none"},
                        }
                        if current_turn_tools:
                            api_kwargs["tools"] = current_turn_tools

                    # 📊 --- LIVE TOKENIZER AUDIT --- 📊
                    try:
                        msg_chars = len(json.dumps(active_input))
                        active_tools_list = api_kwargs.get("tools", [])
                        tool_chars = len(json.dumps(active_tools_list)) if active_tools_list else 0
                        msg_tokens = msg_chars // 4
                        tool_tokens = tool_chars // 4
                        total_tokens = msg_tokens + tool_tokens

                        mode_label = "STATEFUL CHAIN" if (current_turn > 1 and last_response_id) else "INITIAL TURN"
                        print(
                            f"   📊 [TOKEN AUDIT | {mode_label}] Sending ~{total_tokens:,} new tokens to cloud.")
                        print(f"      -> Payload Input: ~{msg_tokens:,} tokens")
                        print(f"      -> Tool Schema:   ~{tool_tokens:,} tokens")
                    except Exception:
                        pass

                    t_api_start = time.perf_counter()

                    try:
                        response_stream = await brain_client.responses.create(
                            **api_kwargs)
                    except Exception as e_api:
                        raise Exception(f"Brain API Failure: {e_api}")

                    first_token = True
                    tool_calls_buffer = {}
                    is_tool_call = False
                    live_tool_names = []
                    full_ai_msg = ""

                    async for event in response_stream:
                        if shortcut_sleep_event.is_set() or stop_event.is_set():
                            break

                        event_type = getattr(event, "type", "")

                        if event_type == "response.created":
                            resp_obj = getattr(event, "response", None)
                            if resp_obj and getattr(resp_obj, "id", None):
                                last_response_id = resp_obj.id

                        elif event_type == "response.output_item.added":
                            item = getattr(event, "item", None)
                            if item and getattr(item, "type", None) == "function_call":
                                is_tool_call = True
                                allowed_identifiers = get_all_valid_tool_identifiers()
                                item_key = getattr(item, "id", None) or getattr(item, "call_id", "unknown")
                                call_id = getattr(item, "call_id", None) or item_key
                                func_name = getattr(item, "name", None) or "unknown"
                                init_args = getattr(item, "arguments", "") or ""

                                if func_name != "unknown" and func_name not in allowed_identifiers:
                                    print(
                                        f"\n🛑 [ROUTER] Prevented hallucinated tool/app call: '{func_name}'")
                                    full_ai_msg += f"\n[SYSTEM ALERT: Prevented invalid tool call '{func_name}'.]"
                                    tool_calls_buffer[item_key] = {"invalid": True}
                                    continue

                                tool_calls_buffer[item_key] = {
                                    "id": call_id,
                                    "name": func_name,
                                    "arguments": init_args,
                                }

                                if func_name != "unknown" and func_name not in live_tool_names:
                                    live_tool_names.append(func_name)
                                    if func_name != "connect_service":
                                        status_payload = (
                                            TOOL_STATUS_MAP.get(
                                                live_tool_names[0], "PROCESSING")
                                            if len(live_tool_names) == 1
                                            else "PARALLEL PROCESSING"
                                        )
                                        print(f"\n⚡ [STATUS]: {status_payload}")
                                        tool_conn = get_connector_for_tool(func_name)
                                        if tool_conn:
                                            active_turn_connectors.add(tool_conn)
                                            await server.broadcast_ui_tag_async(status_payload, connector=tool_conn)
                                        else:
                                            await server.broadcast_ui_tag_async(status_payload)

                        elif event_type == "response.function_call_arguments.delta":
                            item_key = getattr(event, "item_id", None)
                            if item_key in tool_calls_buffer and not tool_calls_buffer[item_key].get("invalid"):
                                tool_calls_buffer[item_key]["arguments"] += getattr(event, "delta", "") or ""

                        elif event_type == "response.output_item.done":
                            item = getattr(event, "item", None)
                            if item and getattr(item, "type", None) == "function_call":
                                item_key = getattr(item, "id", None) or getattr(item, "call_id", "unknown")
                                if item_key in tool_calls_buffer and not tool_calls_buffer[item_key].get("invalid"):
                                    final_args = getattr(item, "arguments", None)
                                    if final_args:
                                        tool_calls_buffer[item_key]["arguments"] = final_args

                                    fn_name = tool_calls_buffer[item_key].get("name", "")
                                    if fn_name == "connect_service":
                                        try:
                                            p_args = json.loads(tool_calls_buffer[item_key]["arguments"] or "{}")
                                        except Exception:
                                            p_args = {}
                                        raw_s = p_args.get("service_name") or p_args.get("service") or ""
                                        svc = resolve_connector_key(raw_s)
                                        if svc:
                                            active_turn_connectors.add(svc)
                                            if svc not in active_connectors:
                                                disp = CONNECTORS_SCHEMA.get(svc, {}).get("display_name", svc.upper())
                                                status_payload = f"CONNECTING TO {disp.upper()}"
                                                print(f"\n⚡ [STATUS]: {status_payload}")
                                                await server.broadcast_ui_tag_async(status_payload, connector=svc)

                        elif event_type == "response.output_text.delta":
                            token = getattr(event, "delta", "")
                            if token:
                                if first_token:
                                    print(
                                        f"   ⏱️ [TIMER] Brain TTFT: {time.perf_counter() - t_api_start:.3f}s\n")
                                    print("✨ [AIDEN]: ", end="", flush=True)
                                    await server.broadcast_stream_start()
                                    first_token = False

                                full_ai_msg += token
                                print(token, end="", flush=True)
                                await server.broadcast_stream_chunk(token, full_ai_msg)
                                await asyncio.sleep(0)

                        elif event_type == "response.completed":
                            resp_obj = getattr(event, "response", None)
                            if resp_obj:
                                if getattr(resp_obj, "id", None):
                                    last_response_id = resp_obj.id
                                usage = getattr(resp_obj, "usage", None)
                                if usage is not None:
                                    try:
                                        prompt_tokens = getattr(usage, "input_tokens", 0)
                                        details = getattr(usage, "input_tokens_details", None)
                                        cached_tokens = getattr(details, "cached_tokens", 0) if details else 0

                                        if prompt_tokens > 0:
                                            savings = (cached_tokens / prompt_tokens) * 100
                                            status = "🟢 CACHE HIT" if cached_tokens > 0 else "🔴 CACHE MISS"
                                            print(
                                                f"\n   🧊 [{status}] Total Prompt: {prompt_tokens:,} | Cached: {cached_tokens:,} ({savings:.1f}% of payload was free!)")
                                    except Exception:
                                        pass

                    # --- PROCESS TOOLS IF REQUIRED ---
                    if is_tool_call:
                        valid_calls = [
                            tc for tc in tool_calls_buffer.values()
                            if not tc.get("invalid")
                        ]

                        if valid_calls:
                            if full_ai_msg:
                                messages.append({"role": "assistant", "content": full_ai_msg})

                            for tc in valid_calls:
                                messages.append({
                                    "type": "function_call",
                                    "call_id": tc["id"],
                                    "name": tc["name"],
                                    "arguments": tc["arguments"] or "{}",
                                })

                            tool_results = []
                            loop = asyncio.get_running_loop()
                            with concurrent.futures.ThreadPoolExecutor() as executor:
                                futures = [
                                    loop.run_in_executor(
                                        executor,
                                        execute_and_intercept,
                                        tc["id"],
                                        tc["name"],
                                        tc["arguments"]
                                    )
                                    for tc in valid_calls
                                ]
                                for fut in asyncio.as_completed(futures):
                                    res = await fut
                                    tool_results.append(res)

                            results_by_id = {r["call_id"]: r for r in tool_results}
                            ordered_results = [
                                results_by_id[tc["id"]]
                                for tc in valid_calls
                                if tc["id"] in results_by_id
                            ]

                            messages.extend(ordered_results)
                            pending_tool_outputs = ordered_results
                        else:
                            break
                    else:
                        print()  # Clean newline after stream finishes
                        await server.broadcast_stream_end(
                            full_ai_msg,
                            connectors=sorted(list(active_turn_connectors))
                        )

                        # 1. Append final text to active messages sequence
                        messages.append(
                            {"role": "assistant", "content": full_ai_msg})

                        # 2. Append to Legacy Memory and Session Tracker
                        chat_history.append(
                            {"user": command, "aiden": full_ai_msg})
                        session_history.append(
                            {"user": command, "aiden": full_ai_msg})
                        if len(chat_history) > 20:
                            chat_history.pop(0)

                        # ⚡ 3. THE SMART TRIMMER: Process this turn into Working Memory ⚡
                        # Preserve exact tool output strings in working_memory so OpenAI's
                        # prefix KV cache remains 100% intact across turns (only strip Base64 images).
                        new_turn_messages = messages[turn_start_index:]
                        for msg in new_turn_messages:
                            if msg.get("type") == "function_call_output":
                                msg.pop("_tool_name", None)
                                content_str = str(msg.get("output", ""))

                                # 🧹 SCREENSHOT WIPE: Delete Base64 images from short-term memory immediately!
                                if "[IMAGE_PAYLOAD_START]" in content_str:
                                    msg["output"] = re.sub(
                                        r"\[IMAGE_PAYLOAD_START\].*?\[IMAGE_PAYLOAD_END\]",
                                        "[IMAGE DELETED FROM SHORT-TERM MEMORY TO SAVE TOKENS]",
                                        content_str,
                                        flags=re.DOTALL
                                    )

                            working_memory.append(msg)

                        break

                if current_turn >= max_turns:
                    print(
                        "\n💀 [SYSTEM] Smart Chain hit the Max Turn Limit (Infinite Loop Protection).")
                    chat_history.append({"user": command, "aiden": full_ai_msg})
                    session_history.append({"user": command, "aiden": full_ai_msg})

                # ⚡ --- WORKING MEMORY SLIDING WINDOW GUARDRAIL --- ⚡
                total_chars = sum(
                    len(str(msg.get("content") or msg.get("output") or msg.get("arguments") or ""))
                    for msg in working_memory
                )
                if total_chars > 18000:
                    print(
                        f"\n>> [SYSTEM] Working memory threshold exceeded ({total_chars} chars). Consolidating securely...")
                    working_memory = working_memory[-14:]
                    while working_memory and working_memory[0].get("role") != "user":
                        working_memory.pop(0)
                    print(
                        ">> [SYSTEM] Short-term context successfully pruned and consolidated.")

            except Exception as e:
                print(f"\n🔴 [CRITICAL BRAIN ERROR]: {e}\n")
                await server.broadcast_event_async({
                    "type": "error",
                    "message": f"Error: {str(e)}",
                })

    await server.stop_ws_server()


if __name__ == "__main__":
    # 1. Silently update the App Registry in RAM on boot
    print(">> [SYSTEM] Synchronizing Master App Registry in RAM...")
    threading.Thread(target=update_registry, daemon=True).start()

    # 2. Boot the in-memory Autonomic Nervous System
    print(">> [SYSTEM] Booting Autonomic Nervous System (ANS)...")
    threading.Thread(target=run_ans, daemon=True).start()

    # 3. Boot the Wake Word Engine in background
    print(">> [SYSTEM] Booting Wake Word Engine ('aiden.onnx')...")
    start_wake_word_engine(wake_word_event, assistant_busy_event, stop_event)

    # 4. Boot the Dynamic Physical Shortcut Detector (Windows + Space)
    print(">> [SYSTEM] Booting Dynamic Physical Shortcut Detector...")
    init_shortcut_detector(shortcut_wake_event, shortcut_sleep_event)

    # 5. Start the headless CLI & WebSocket loop
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        stop_event.set()
        detector = get_shortcut_detector()
        if detector:
            detector.stop()
        print("\nSystems shutting down.")
