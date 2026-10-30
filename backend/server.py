import asyncio
import json
import queue
import sys
import threading
from typing import Any, Dict, Optional, Set
import websockets

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    from tts_engine import synthesize_speech_base64
except ImportError:
    from backend.tts_engine import synthesize_speech_base64

try:
    from voice_engine import init_voice_engine, get_voice_engine
except ImportError:
    from backend.voice_engine import init_voice_engine, get_voice_engine

# Connected WebSocket clients (Launcher Window + Chat Pill Window)
_connected_clients: Set[Any] = set()
_server_loop: Optional[asyncio.AbstractEventLoop] = None
_ws_server: Optional[Any] = None

# Thread-safe command queue from UI -> main.py
ui_command_queue: "queue.Queue[str]" = queue.Queue()

# References to main.py threading events
_wake_event: Optional[threading.Event] = None
_sleep_event: Optional[threading.Event] = None
_stop_event: Optional[threading.Event] = None

# Active state snapshot sent immediately to newly connected UI clients
_current_state: Dict[str, Any] = {
    "isAwake": False,
    "wakeSource": None,
    "mood": None,
}


def init_bridge(
    wake_event: threading.Event,
    sleep_event: threading.Event,
    stop_event: threading.Event,
):
    """Links main.py's coordination events with the WebSocket server."""
    global _wake_event, _sleep_event, _stop_event
    _wake_event = wake_event
    _sleep_event = sleep_event
    _stop_event = stop_event


def get_pending_ui_command() -> Optional[str]:
    """Non-blocking pop of the next user command sent from the Chat Pill UI."""
    try:
        return ui_command_queue.get_nowait()
    except queue.Empty:
        return None


def clear_pending_ui_commands():
    """Clears any queued commands when transitioning to sleep."""
    while not ui_command_queue.empty():
        try:
            ui_command_queue.get_nowait()
        except queue.Empty:
            break


async def _send_safe(ws: Any, message_str: str):
    try:
        await ws.send(message_str)
    except Exception:
        _connected_clients.discard(ws)


async def broadcast_event_async(payload: Dict[str, Any]):
    """Direct non-blocking async broadcast with zero queuing latency."""
    if not _connected_clients:
        return
    message_str = json.dumps(payload)
    clients_snapshot = list(_connected_clients)
    await asyncio.gather(
        *[_send_safe(ws, message_str) for ws in clients_snapshot],
        return_exceptions=True,
    )


def broadcast_event(payload: Dict[str, Any]):
    """Thread-safe broadcast fallback for background threads."""
    global _server_loop
    if _server_loop is None or _server_loop.is_closed():
        return
    try:
        asyncio.run_coroutine_threadsafe(broadcast_event_async(payload), _server_loop)
    except Exception:
        pass


def _on_audio_meter(level: float, bass: float, mid: float, high: float):
    broadcast_event({
        "type": "audio_meter",
        "level": round(level, 3),
        "bass": round(bass, 3),
        "mid": round(mid, 3),
        "high": round(high, 3),
    })


def _on_voice_transcription(text: str):
    if not text:
        return
    print(f"💬 [VOICE COMMAND] Transcribed: \"{text}\"")
    ui_command_queue.put(text)
    if not _current_state["isAwake"] and _wake_event is not None:
        _wake_event.set()
    broadcast_event({
        "type": "voice_transcription",
        "text": text,
        "from_voice": True,
    })


def _on_voice_status(status: str):
    broadcast_event({
        "type": "voice_status",
        "status": status,
    })


def _on_voice_active(active: bool):
    broadcast_event({
        "type": "voice_active",
        "active": active,
    })


def _on_voice_recording(recording: bool):
    broadcast_event({
        "type": "voice_recording",
        "isRecording": recording,
    })


async def broadcast_state_async(
    is_awake: bool,
    wake_source: Optional[str] = None,
    mood: Optional[str] = None,
):
    """Updates and asynchronously broadcasts Aiden's sleep/awake state to the UI."""
    _current_state["isAwake"] = is_awake
    _current_state["wakeSource"] = wake_source
    if mood is not None:
        _current_state["mood"] = mood

    await broadcast_event_async({
        "type": "state",
        "isAwake": is_awake,
        "backendOnline": True,
        "wakeSource": wake_source,
        "mood": _current_state.get("mood"),
    })


def broadcast_state(
    is_awake: bool,
    wake_source: Optional[str] = None,
    mood: Optional[str] = None,
):
    """Thread-safe sync wrapper for broadcast_state."""
    global _server_loop
    if _server_loop and not _server_loop.is_closed():
        try:
            asyncio.run_coroutine_threadsafe(
                broadcast_state_async(is_awake, wake_source, mood), _server_loop
            )
            return
        except Exception:
            pass
    _current_state["isAwake"] = is_awake


async def broadcast_ui_tag_async(tag: str):
    """Directly pushes an active execution status tag to the Reply Window."""
    await broadcast_event_async({
        "type": "ui_tag",
        "tag": tag,
    })


def broadcast_ui_tag(tag: str):
    """Sync wrapper for broadcast_ui_tag."""
    broadcast_event({
        "type": "ui_tag",
        "tag": tag,
    })


async def broadcast_stream_start():
    """Immediately notifies the Reply Window that text token streaming has begun."""
    await broadcast_event_async({
        "type": "stream_start",
    })


async def broadcast_stream_chunk(token: str, full_content: str):
    """Directly flushes an individual LLM token to the Reply Window in real-time."""
    await broadcast_event_async({
        "type": "stream_chunk",
        "token": token,
        "fullContent": full_content,
    })


async def broadcast_stream_end(full_content: str):
    """Marks completion of the streamed assistant reply."""
    await broadcast_event_async({
        "type": "stream_end",
        "fullContent": full_content,
    })


async def handle_connection(websocket: Any):
    """Handles a single WebSocket client connection from Tauri (Launcher or Chat Pill)."""
    _connected_clients.add(websocket)
    print(f"🔗 [WS BRIDGE] UI client connected ({len(_connected_clients)} active).")

    # Send initial state snapshot immediately upon connection
    try:
        await websocket.send(json.dumps({
            "type": "state",
            "isAwake": _current_state["isAwake"],
            "backendOnline": True,
            "wakeSource": _current_state["wakeSource"],
            "mood": _current_state["mood"],
        }))

        async for raw_message in websocket:
            try:
                data = json.loads(raw_message)
            except Exception:
                data = {"type": "command", "text": str(raw_message)}

            msg_type = data.get("type")

            if msg_type == "command":
                text = str(data.get("text", "")).strip()
                if text:
                    print(f"💬 [WS BRIDGE] Command received from Chat UI: {text}")
                    ui_command_queue.put(text)
                    if not _current_state["isAwake"] and _wake_event is not None:
                        _wake_event.set()

            elif msg_type in ("voice_arm", "voice_start"):
                print("🎙️ [WS BRIDGE] Voice mode armed.")
                ve = get_voice_engine()
                if ve:
                    ve.arm()

            elif msg_type in ("voice_disarm", "voice_stop", "voice_cancel"):
                print("⏹️ [WS BRIDGE] Voice mode disarmed.")
                ve = get_voice_engine()
                if ve:
                    ve.disarm()

            elif msg_type == "recording_start":
                print("🔴 [WS BRIDGE] Recording started (Push-to-Talk).")
                ve = get_voice_engine()
                if ve:
                    ve.start_recording(origin="ui")

            elif msg_type == "recording_stop":
                print("⏹️ [WS BRIDGE] Recording stopped. Transcribing...")
                ve = get_voice_engine()
                if ve:
                    ve.stop_recording(and_transcribe=True)

            elif msg_type == "recording_cancel":
                print("❌ [WS BRIDGE] Recording cancelled.")
                ve = get_voice_engine()
                if ve:
                    ve.stop_recording(and_transcribe=False)

            elif msg_type == "wake":
                if _wake_event is not None:
                    _wake_event.set()

            elif msg_type == "sleep":
                if _sleep_event is not None:
                    _sleep_event.set()

            elif msg_type == "toggle_sleep":
                if _current_state["isAwake"]:
                    if _sleep_event is not None:
                        _sleep_event.set()
                else:
                    if _wake_event is not None:
                        _wake_event.set()

            elif msg_type == "shutdown":
                print("🛑 [WS BRIDGE] Shutdown signal received from Control Panel.")
                if _stop_event is not None:
                    _stop_event.set()
                if _sleep_event is not None:
                    _sleep_event.set()

            elif msg_type == "ping":
                await websocket.send(json.dumps({
                    "type": "pong",
                    "isAwake": _current_state["isAwake"],
                    "backendOnline": True,
                }))

            elif msg_type == "tts_request":
                text_to_speak = str(data.get("text", "")).strip()
                turn_id = str(data.get("turnId", ""))
                voice = str(data.get("voice", "nova"))
                if text_to_speak:
                    try:
                        b64_audio = await synthesize_speech_base64(text_to_speak, voice=voice)
                        await websocket.send(json.dumps({
                            "type": "tts_response",
                            "turnId": turn_id,
                            "audioBase64": b64_audio,
                            "format": "mp3",
                        }))
                    except Exception as e:
                        print(f"⚠️ [TTS] Synthesis error: {e}")
                        await websocket.send(json.dumps({
                            "type": "tts_error",
                            "turnId": turn_id,
                            "error": str(e),
                        }))

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"⚠️ [WS BRIDGE] Client handler error: {e}")
    finally:
        _connected_clients.discard(websocket)
        print(f"🔌 [WS BRIDGE] UI client disconnected ({len(_connected_clients)} active).")


async def start_ws_server(host: str = "127.0.0.1", port: int = 8765):
    """Starts the WebSocket server inside main.py's asyncio loop."""
    global _server_loop, _ws_server
    _server_loop = asyncio.get_running_loop()
    init_voice_engine(
        on_meter=_on_audio_meter,
        on_transcription=_on_voice_transcription,
        on_status=_on_voice_status,
        on_active=_on_voice_active,
        on_recording=_on_voice_recording,
        loop=_server_loop,
    )
    _ws_server = await websockets.serve(handle_connection, host, port)
    print(f"🌐 [WS BRIDGE] Listening for UI connections on ws://{host}:{port}")
    return _ws_server


async def stop_ws_server():
    """Gracefully closes the WebSocket server on shutdown."""
    global _ws_server
    ve = get_voice_engine()
    if ve:
        ve.disarm()
    if _ws_server is not None:
        try:
            _ws_server.close()
            await _ws_server.wait_closed()
        except Exception:
            pass
        _ws_server = None


if __name__ == "__main__":
    async def _standalone():
        await start_ws_server()
        await asyncio.Future()

    asyncio.run(_standalone())
