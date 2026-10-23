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
from connectors import CONNECTORS_SCHEMA, get_connector_tool_names
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

    # YouTube & Visuals
    "search_youtube": "SEARCHING YOUTUBE",
    "open_youtube_video": "OPENING YOUTUBE",
    "search_images": "SEARCHING IMAGES",

    # Spotify Integration
    "search_spotify_catalog": "SCANNING SPOTIFY",
    "get_currently_playing_metadata": "CHECKING SPOTIFY",
    "get_user_playlists": "READING LIBRARY",
    "get_playlist_items": "INSPECTING PLAYLIST",

    # Local Files
    "search_files": "SCANNING FILES",

    # Mail Utilities
    "search_emails": "SEARCHING INBOX",
    "read_email_thread": "READING EMAIL",
    "mark_email_as_read": "MARKING EMAILS AS READ",
    "open_email_in_app": "OPENING EMAIL",
    "draft_email": "DRAFTING EMAIL",
    "send_email": "SENDING EMAIL",

    # Calendar Utilities
    "list_calendar_events": "SCANNING CALENDAR",
    "read_event_details": "READING EVENT DETAILS",
    "add_calendar_event": "BOOKING EVENT",
    "update_calendar_event": "UPDATING EVENT",
    "delete_calendar_event": "DELETING EVENT",

    # Notes Vault (Obsidian & Notion)
    "get_obsidian_vaults": "SEARCHING VAULTS",
    "scan_obsidian_vault": "ACCESSING VAULT",
    "read_obsidian_note": "READING NOTE",
    "modify_obsidian_note": "EDITING NOTE",
    "open_obsidian_note": "OPENING NOTE",
    "map_obsidian_graph": "MAPPING VAULT",
    "scan_notion_workspace": "SCANNING WORKSPACE",
    "open_notion_page_in_app": "OPENING PAGE"
}

# ---------------------------------------------------------
# 1. UI EVENT BRIDGE & ROUTERS
# ---------------------------------------------------------


def emit_ui_event(event_type: str, data=None):
    """
    Dispatches structured UI events (e.g. VIDEO_CARDS, IMAGE_CARDS) over the WebSocket bridge
    and logs a summary to the terminal.
    """
    if isinstance(data, list):
        summary = f"({len(data)} items)"
    elif isinstance(data, dict):
        summary = f"(keys: {list(data.keys())})"
    elif data is not None:
        summary = f"-> {data}"
    else:
        summary = ""
    print(f"\n🖥️ [UI EVENT | {event_type}] {summary}")
    server.broadcast_event({
        "type": "ui_event",
        "eventType": event_type,
        "data": data,
    })


def route_connectors(user_prompt, connectors_data):
    """Scans the user prompt against the connector stacks and returns matches."""
    triggered = []
    if not user_prompt or not connectors_data:
        return triggered

    prompt_lower = user_prompt.lower()
    for stack_name, stack_data in connectors_data.items():
        if any(re.search(rf"\b{kw}\b", prompt_lower) for kw in stack_data.get("keywords", [])):
            triggered.append(stack_name)
    return triggered


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
# 2. TOOL EXECUTION & INTERCEPTOR ENGINE
# ---------------------------------------------------------

def execute_and_intercept(tc_id, func_name, arguments_str):
    """Executes a single tool and formats LLM context instructions."""
    try:
        args = json.loads(arguments_str)
    except Exception:
        args = {}

    print(f"   ⚙ [WORKER] Executing: {func_name}({args})")

    try:
        if tool_registry and func_name in tool_registry.AVAILABLE_TOOLS:
            result = tool_registry.AVAILABLE_TOOLS[func_name](**args)
        else:
            result = f"Error: Tool {func_name} not found."
    except Exception as e:
        result = f"Error executing tool: {str(e)}"

    tool_result = str(result)

    # --- UI PAYLOAD INTERCEPTORS ---
    if func_name == "search_youtube" and tool_result.startswith('{"action": "RENDER_VIDEOS"'):
        try:
            payload = json.loads(tool_result)
            emit_ui_event("VIDEO_CARDS", payload["videos"])
            links_info = " | ".join(
                [f"'{v['title']}' (URL: {v['link']})" for v in payload["videos"]])
            tool_result = (
                "SYSTEM ACTION COMPLETE: Video cards are now instantly displayed on the user's UI. "
                "CRITICAL INSTRUCTION: You MUST respond with ONLY a single short sentence like 'I found some videos for you.' "
                "DO NOT read the titles. DO NOT read the URLs. Keep these URLs in your memory. "
                "If the user asks you to 'open' or 'play' one of these videos, you MUST use the 'open_in_browser' tool "
                f"with the exact URL. DO NOT use 'launch_app' for these videos. Available videos: {links_info}"
            )
        except Exception as e:
            tool_result = f"Failed to render videos to UI: {e}"

    elif func_name == "search_images" and tool_result.startswith('{"action": "RENDER_IMAGES"'):
        try:
            payload = json.loads(tool_result)
            emit_ui_event("IMAGE_CARDS", payload["images"])
            img_info = " | ".join(
                [f"Image: '{img['title']}'" for img in payload["images"]])
            tool_result = (
                f"SYSTEM ACTION COMPLETE: Visual image examples are now actively rendered horizontally on the user's UI window. "
                f"Visual Details Present on UI: {img_info}. "
                f"CRITICAL INSTRUCTION: Synthesize your final answer explaining the core concept clearly. "
                f"Acknowledge conversationally that you have pulled up these visual references on their display screen. "
                f"DO NOT read out raw source URLs or explicit image paths."
            )
        except Exception as e:
            tool_result = f"Failed to render web images to UI: {e}"

    print(
        f"   📥 [RESULT]: Data received from {func_name} (Length: {len(tool_result)} chars)")
    return {"role": "tool", "tool_call_id": tc_id, "name": func_name, "content": tool_result}


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
                messages = [{"role": "system", "content": static_system_rules}]

                # 2. CLEAN WORKING MEMORY: Inject past turns
                if working_memory:
                    messages.extend(working_memory)

                # 3. BUILD THE GHOST CONTAINER (Layer 4)
                ghost_content = dynamic_consciousness
                if ghost_content.strip():
                    messages.append(
                        {"role": "system", "content": f"--- LIVE TELEMETRY & CONTEXT ---\n{ghost_content.strip()}"}
                    )

                # 4. THE TRIGGER (Layer 5)
                new_user_msg = {"role": "user", "content": command}
                messages.append(new_user_msg)

                # 5. THE SMART TRIMMER MARKER
                turn_start_index = len(messages) - 1

                # ⚡ THE AGENTIC SMART CHAIN LOOP
                max_turns = 15
                current_turn = 0

                while current_turn < max_turns:
                    if shortcut_sleep_event.is_set() or stop_event.is_set():
                        break

                    current_turn += 1
                    print(f"\n🧠 [BRAIN] Thinking (Turn {current_turn})...")

                    api_kwargs = {
                        "messages": messages,
                        "stream": True,
                        "stream_options": {"include_usage": True},
                        "model": "gpt-5.6-luna",
                        "temperature": 0.8,
                        "reasoning_effort": "none"
                    }

                    # ⚡ THE DYNAMIC TOOL ROUTER INJECTION ⚡
                    current_turn_tools = []
                    if tool_registry_schema:
                        current_turn_tools = list(tool_registry_schema)

                        if current_turn == 1:
                            triggered_stacks = route_connectors(
                                command, connectors_registry_schema)
                            for stack in triggered_stacks:
                                if stack not in active_connectors:
                                    print(
                                        f"🔌 [ROUTER] Waking up connector stack: {stack}")
                                    active_connectors.add(stack)

                        for stack_name in active_connectors:
                            current_turn_tools.extend(
                                connectors_registry_schema[stack_name]["tools"])

                        api_kwargs["tools"] = current_turn_tools

                    # 📊 --- LIVE TOKENIZER AUDIT --- 📊
                    try:
                        msg_chars = len(json.dumps(messages))
                        tool_chars = len(json.dumps(current_turn_tools)
                                         ) if tool_registry_schema else 0
                        msg_tokens = msg_chars // 4
                        tool_tokens = tool_chars // 4
                        total_tokens = msg_tokens + tool_tokens

                        print(
                            f"   📊 [TOKEN AUDIT] Sending ~{total_tokens:,} tokens to cloud.")
                        print(f"      -> Context & Memory: ~{msg_tokens:,} tokens")
                        print(
                            f"      -> Tool Schema:      ~{tool_tokens:,} tokens")
                    except Exception:
                        pass

                    t_api_start = time.perf_counter()

                    try:
                        response_stream = await brain_client.chat.completions.create(
                            **api_kwargs)
                    except Exception as e_api:
                        raise Exception(f"Brain API Failure: {e_api}")

                    first_token = True
                    tool_calls_buffer = {}
                    is_tool_call = False
                    live_tool_names = []
                    full_ai_msg = ""

                    async for chunk in response_stream:
                        if shortcut_sleep_event.is_set() or stop_event.is_set():
                            break

                        # 📊 --- CACHE HIT/MISS INTERCEPTOR --- 📊
                        if hasattr(chunk, 'usage') and chunk.usage is not None:
                            try:
                                prompt_tokens = chunk.usage.prompt_tokens
                                cached_tokens = getattr(
                                    chunk.usage.prompt_tokens_details, 'cached_tokens', 0)

                                if prompt_tokens > 0:
                                    savings = (cached_tokens / prompt_tokens) * 100
                                    status = "🟢 CACHE HIT" if cached_tokens > 0 else "🔴 CACHE MISS"
                                    print(
                                        f"\n   🧊 [{status}] Total Prompt: {prompt_tokens:,} | Cached: {cached_tokens:,} ({savings:.1f}% of payload was free!)")
                            except Exception:
                                pass

                        if not hasattr(chunk, 'choices') or not chunk.choices:
                            continue

                        delta = chunk.choices[0].delta

                        # --- TOOL CALL STREAMING ---
                        if delta.tool_calls:
                            is_tool_call = True
                            allowed_identifiers = get_all_valid_tool_identifiers()

                            for tc in delta.tool_calls:
                                if tc.index not in tool_calls_buffer:
                                    func_name = tc.function.name if tc.function and tc.function.name else "unknown"

                                    if func_name != "unknown" and func_name not in allowed_identifiers:
                                        print(
                                            f"\n🛑 [ROUTER] Prevented hallucinated tool/app call: '{func_name}'")
                                        full_ai_msg += f"\n[SYSTEM ALERT: Prevented invalid tool call '{func_name}'.]"
                                        tool_calls_buffer[tc.index] = {
                                            "invalid": True}
                                        continue

                                    tool_calls_buffer[tc.index] = {
                                        "id": tc.id, "name": func_name, "arguments": ""}

                                    if func_name != "unknown" and func_name not in live_tool_names:
                                        live_tool_names.append(func_name)
                                        status_payload = (
                                            TOOL_STATUS_MAP.get(
                                                live_tool_names[0], "PROCESSING")
                                            if len(live_tool_names) == 1
                                            else "PARALLEL PROCESSING"
                                        )
                                        print(f"\n⚡ [STATUS]: {status_payload}")
                                        await server.broadcast_ui_tag_async(status_payload)

                                if tool_calls_buffer.get(tc.index, {}).get("invalid"):
                                    continue

                                if tc.function and tc.function.arguments:
                                    tool_calls_buffer[tc.index]["arguments"] += tc.function.arguments

                        # --- TEXT CONTENT STREAMING (REAL-TIME ASYNC FLUSH) ---
                        elif delta.content:
                            token = delta.content
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

                    # --- PROCESS TOOLS IF REQUIRED ---
                    if is_tool_call:
                        executed_tool_names = []
                        assistant_msg = {
                            "role": "assistant",
                            "content": full_ai_msg if full_ai_msg else None,
                            "tool_calls": []
                        }

                        for index, tc in tool_calls_buffer.items():
                            if tc.get("invalid"):
                                continue
                            func_name = tc["name"]
                            arguments_str = tc["arguments"]
                            executed_tool_names.append(func_name)
                            assistant_msg["tool_calls"].append({
                                "id": tc["id"],
                                "type": "function",
                                "function": {"name": func_name, "arguments": arguments_str}
                            })

                        if executed_tool_names:
                            messages.append(assistant_msg)
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
                                    for index, tc in tool_calls_buffer.items()
                                    if not tc.get("invalid")
                                ]
                                for fut in asyncio.as_completed(futures):
                                    res = await fut
                                    tool_results.append(res)

                            messages.extend(tool_results)
                        else:
                            break
                    else:
                        print()  # Clean newline after stream finishes
                        await server.broadcast_stream_end(full_ai_msg)

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
                        new_turn_messages = messages[turn_start_index:]
                        for msg in new_turn_messages:
                            if msg.get("role") == "tool":
                                content_str = str(msg.get("content", ""))

                                # 🧹 SCREENSHOT WIPE: Delete Base64 images from short-term memory immediately!
                                if "[IMAGE_PAYLOAD_START]" in content_str:
                                    content_str = re.sub(
                                        r"\[IMAGE_PAYLOAD_START\].*?\[IMAGE_PAYLOAD_END\]",
                                        "[IMAGE DELETED FROM SHORT-TERM MEMORY TO SAVE TOKENS]",
                                        content_str,
                                        flags=re.DOTALL
                                    )
                                    msg["content"] = content_str
                                elif len(content_str) > 2500:
                                    msg["content"] = (
                                        content_str[:1000]
                                        + f"\n\n...[SYSTEM OPTIMIZATION: {len(content_str)} bytes of raw tool data were dynamically truncated from short-term memory after processing to preserve token bandwidth.]"
                                    )

                            working_memory.append(msg)

                        break

                if current_turn >= max_turns:
                    print(
                        "\n💀 [SYSTEM] Smart Chain hit the Max Turn Limit (Infinite Loop Protection).")
                    chat_history.append({"user": command, "aiden": full_ai_msg})
                    session_history.append({"user": command, "aiden": full_ai_msg})

                # ⚡ --- WORKING MEMORY SLIDING WINDOW GUARDRAIL --- ⚡
                total_chars = sum(len(str(msg.get("content", "")))
                                  for msg in working_memory)
                if total_chars > 30000:
                    print(
                        f"\n>> [SYSTEM] Working memory threshold exceeded ({total_chars} chars). Consolidating securely...")
                    working_memory = working_memory[-16:]
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
