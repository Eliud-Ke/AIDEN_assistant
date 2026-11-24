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
    from voice_engine import init_voice_engine, get_voice_engine
except ImportError:
    from backend.voice_engine import init_voice_engine, get_voice_engine

# Connected WebSocket clients (Launcher Window + Chat Pill Window)
_connected_clients: Set[Any] = set()
_server_loop: Optional[asyncio.AbstractEventLoop] = None
_ws_server: Optional[Any] = None

# Thread-safe command queue from UI -> main.py (str or structured dict with text/images/reasoning_effort)
ui_command_queue: "queue.Queue[Any]" = queue.Queue()

# UI surface visibility state (tracks whether chat_pill is minimized to 68x68 Living Cube)
_ui_surface_lock = threading.Lock()
_ui_surface_state: Dict[str, Any] = {
    "pipMinimized": False,
}

# Turn-Barrier System Mailbox (proactive turns like Antigravity completion or inline card dismissal)
_system_mailbox_lock = threading.Lock()
_system_mailbox: list = []

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


def set_ui_pip_minimized(minimized: bool) -> None:
    """Updates whether ChatPill is currently collapsed into the 68x68 Living Cube."""
    with _ui_surface_lock:
        _ui_surface_state["pipMinimized"] = bool(minimized)


def is_ui_pip_minimized() -> bool:
    """Returns True when ChatPill is minimized into the 68x68 Living Cube."""
    with _ui_surface_lock:
        return bool(_ui_surface_state["pipMinimized"])


def enqueue_system_turn(
    kind: str,
    prompt: str,
    job_id: str = "",
    require_maximized: bool = True,
    ui_tag: str = "",
) -> None:
    """
    Thread-safe push into the Turn-Barrier Mailbox.
    Delivered strictly between active LLM turns so it can never collide with an in-flight stream.
    """
    entry = {
        "kind": kind,
        "prompt": prompt,
        "job_id": job_id,
        "require_maximized": bool(require_maximized),
        "ui_tag": ui_tag,
    }
    with _system_mailbox_lock:
        if job_id:
            for existing in _system_mailbox:
                if existing.get("kind") == kind and existing.get("job_id") == job_id:
                    return
        _system_mailbox.append(entry)


def remove_system_turns_for_job(job_id: str, kinds: Optional[tuple] = None) -> None:
    """Removes queued mailbox items for a job (e.g. if canceled or already checked manually)."""
    if not job_id:
        return
    with _system_mailbox_lock:
        _system_mailbox[:] = [
            item
            for item in _system_mailbox
            if not (
                item.get("job_id") == job_id
                and (kinds is None or item.get("kind") in kinds)
            )
        ]


def pop_ready_system_turn() -> Optional[Dict[str, Any]]:
    """
    Pops the next eligible Turn-Barrier system turn.
    Items with require_maximized=True remain safely queued while minimized to PiP Cube,
    then fire immediately the moment the user expands back into ChatPill.
    """
    minimized = bool(_connected_clients) and is_ui_pip_minimized()
    with _system_mailbox_lock:
        for idx, item in enumerate(_system_mailbox):
            if item.get("require_maximized") and minimized:
                continue
            return _system_mailbox.pop(idx)
    return None


def clear_transient_system_turns_on_sleep() -> None:
    """
    Clears transient dismiss-acknowledgement turns on sleep while preserving any
    unreported Antigravity completion reports so AIDEN announces them upon waking.
    """
    with _system_mailbox_lock:
        _system_mailbox[:] = [
            item for item in _system_mailbox if item.get("kind") == "agy_done"
        ]


def get_pending_ui_command() -> Optional[Any]:
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


async def broadcast_ui_tag_async(tag: str, connector: Optional[str] = None):
    """Directly pushes an active execution status tag to the Reply Window."""
    payload: Dict[str, Any] = {
        "type": "ui_tag",
        "tag": tag,
    }
    if connector:
        payload["connector"] = connector
    await broadcast_event_async(payload)


def broadcast_ui_tag(tag: str, connector: Optional[str] = None):
    """Sync wrapper for broadcast_ui_tag."""
    payload: Dict[str, Any] = {
        "type": "ui_tag",
        "tag": tag,
    }
    if connector:
        payload["connector"] = connector
    broadcast_event(payload)


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


def estimate_response_height(text: str, connectors: Optional[list] = None) -> float:
    """Calculates estimated pixel height of response card for DWM & Chromium lockstep animation."""
    # Base container: top padding (16px) + speaker/close button headroom (32px) + bottom margin/padding (32px)
    base_h = 80.0

    clean_text = (text or "").strip()
    if clean_text:
        lines = clean_text.split("\n")
        total_wrapped_lines = 0
        for line in lines:
            trimmed = line.strip()
            if not trimmed:
                total_wrapped_lines += 1
                continue
            # Approximately 52 chars per line inside 430px text wrap at 14px Segoe UI Variable
            wrapped = max(1, (len(trimmed) + 51) // 52)
            total_wrapped_lines += wrapped
        # ~22px line height per rendered markdown line
        text_h = total_wrapped_lines * 22.0
    else:
        text_h = 40.0

    # Extra height for embedded cards
    conn_h = 0.0
    if connectors:
        if any(c in connectors for c in ["spotify_track", "spotify_artist", "spotify_album", "spotify"]):
            conn_h += 135.0
        elif any(c in connectors for c in ["clock", "weather"]):
            conn_h += 110.0
        else:
            conn_h += 50.0

    total_h = base_h + text_h + conn_h
    # Clamp to valid response card bounds (min 120px, max 620px matching CSS)
    return float(max(120.0, min(620.0, total_h)))


async def broadcast_stream_end(
    full_content: str,
    connectors: Optional[list] = None,
    target_height: Optional[float] = None,
    proactive_kind: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
):
    """Marks completion of the streamed assistant reply."""
    calc_h = target_height if target_height is not None else estimate_response_height(full_content, connectors)
    payload: Dict[str, Any] = {
        "type": "stream_end",
        "fullContent": full_content,
        "targetHeight": calc_h,
    }
    if connectors:
        payload["connectors"] = connectors
    if proactive_kind:
        payload["proactiveKind"] = proactive_kind
    if reasoning_effort and reasoning_effort != "none":
        payload["reasoningEffort"] = reasoning_effort
    await broadcast_event_async(payload)


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
        try:
            try:
                import tools_antigravity
            except ImportError:
                from backend import tools_antigravity  # type: ignore
            work_snap = tools_antigravity.get_active_work_ui_snapshot()
            if work_snap:
                await websocket.send(json.dumps(work_snap))
        except Exception:
            pass

        async for raw_message in websocket:
            try:
                data = json.loads(raw_message)
            except Exception:
                data = {"type": "command", "text": str(raw_message)}

            msg_type = data.get("type")

            if msg_type == "command":
                text = str(data.get("text", "")).strip()
                raw_images = data.get("images")
                clean_images = []
                if isinstance(raw_images, list):
                    for item in raw_images[:4]:
                        if isinstance(item, dict):
                            durl = str(item.get("dataUrl") or item.get("data_url") or "").strip()
                            if durl.startswith("data:image/"):
                                clean_images.append({
                                    "dataUrl": durl,
                                    "name": str(item.get("name") or "image")[:80],
                                })
                raw_effort = str(data.get("reasoningEffort") or "none").strip().lower()
                reasoning_effort = "high" if raw_effort == "high" else "none"

                if text or clean_images:
                    print(
                        f"💬 [WS BRIDGE] Command received from Chat UI: "
                        f"{text[:80] if text else '[image-only]'} "
                        f"(images={len(clean_images)}, reasoning={reasoning_effort})"
                    )
                    ui_command_queue.put({
                        "text": text,
                        "images": clean_images,
                        "reasoning_effort": reasoning_effort,
                    })
                    if not _current_state["isAwake"] and _wake_event is not None:
                        _wake_event.set()

            elif msg_type == "hardware_control":
                # Real-time zero-latency hardware control (Volume / Brightness)
                control_action = data.get("action")
                level = data.get("level")
                muted = data.get("muted")
                try:
                    try:
                        import comtypes
                        comtypes.CoInitialize()
                    except Exception:
                        pass

                    if control_action == "volume":
                        from tools_system import set_system_volume
                        if level is not None:
                            set_system_volume(str(level))
                        elif muted is not None:
                            try:
                                from pycaw.pycaw import AudioUtilities
                                device = AudioUtilities.GetSpeakers()
                                volume = device.EndpointVolume
                                volume.SetMute(1 if muted else 0, None)
                            except Exception as mute_err:
                                print(f"⚠️ [HARDWARE CONTROL] Mute error: {mute_err}")
                    elif control_action == "brightness":
                        from tools_system import set_system_brightness
                        if level is not None:
                            set_system_brightness(str(level))
                except Exception as e:
                    print(f"⚠️ [HARDWARE CONTROL] Error: {e}")

            elif msg_type == "spotify_play":
                spotify_id = str(data.get("spotifyId", "")).strip()
                item_type = str(data.get("itemType", "track")).strip() or "track"
                if spotify_id:
                    def _run_spotify_play(sid: str, itype: str):
                        try:
                            if itype.strip().lower() == "playlist":
                                try:
                                    from tools_spotify import spotify_play_playlist
                                except ImportError:
                                    from backend.tools_spotify import spotify_play_playlist
                                res_msg = spotify_play_playlist(sid)
                            else:
                                try:
                                    from tools_spotify import spotify_play_item
                                except ImportError:
                                    from backend.tools_spotify import spotify_play_item
                                res_msg = spotify_play_item(sid, itype)
                            print(f"🎵 [SPOTIFY DIRECT PLAY] {itype}:{sid} -> {res_msg}")
                        except Exception as sp_err:
                            print(f"⚠️ [SPOTIFY DIRECT PLAY] Error: {sp_err}")
                    threading.Thread(
                        target=_run_spotify_play,
                        args=(spotify_id, item_type),
                        daemon=True,
                    ).start()

            elif msg_type == "clear_response":
                print("🧹 [WS BRIDGE] Clear response received.")
                await broadcast_event_async({
                    "type": "clear_response"
                })

            elif msg_type == "ui_surface":
                set_ui_pip_minimized(bool(data.get("pipMinimized", False)))

            elif msg_type == "agy_card_dismissed":
                job_id = str(data.get("job_id", "")).strip()
                try:
                    try:
                        import tools_antigravity
                    except ImportError:
                        from backend import tools_antigravity  # type: ignore
                    dismissed = tools_antigravity.mark_job_dismissed(job_id)
                except Exception as agy_err:
                    print(f"⚠️ [WS BRIDGE] agy_card_dismissed error: {agy_err}")
                    dismissed = None

                if dismissed:
                    dismiss_prompt = (
                        f"[ANTIGRAVITY INLINE CARD MINIMIZED - {dismissed['job_id']}]: "
                        f"The user has seen the live progress card for '{dismissed['task']}' and "
                        f"minimized/dismissed it to continue chatting with you while Antigravity keeps "
                        f"running in the background. Reply in ONE short, warm, natural sentence letting "
                        f"them know you will notify them as soon as it is done and asking if there is "
                        f"anything else they need right now. Do NOT call any tools."
                    )
                    print(f"🛠️ [WS BRIDGE] Inline Antigravity card dismissed for {dismissed['job_id']}; queuing acknowledgement.")
                    enqueue_system_turn(
                        kind="agy_dismissed",
                        prompt=dismiss_prompt,
                        job_id=dismissed["job_id"],
                        require_maximized=True,
                        ui_tag="Continuing in background",
                    )

            elif msg_type == "agy_stop_task":
                job_id = str(data.get("job_id", "")).strip()
                def _run_agy_stop(jid: str):
                    try:
                        try:
                            import tools_antigravity
                        except ImportError:
                            from backend import tools_antigravity  # type: ignore
                        res_msg = tools_antigravity.agy_cancel_task(jid)
                        print(f"🛑 [WS BRIDGE] Direct inline stop for {jid or 'latest'}: {res_msg}")
                    except Exception as stop_err:
                        print(f"⚠️ [WS BRIDGE] Direct inline stop error: {stop_err}")
                threading.Thread(
                    target=_run_agy_stop,
                    args=(job_id,),
                    daemon=True,
                ).start()

            elif msg_type in ("voice_arm", "voice_start"):
                print("🎙️ [WS BRIDGE] Voice mode armed.")
                ve = get_voice_engine()
                if ve:
                    ve.arm()
                await broadcast_event_async({"type": "voice_start"})

            elif msg_type in ("voice_disarm", "voice_stop", "voice_cancel"):
                print("⏹️ [WS BRIDGE] Voice mode disarmed.")
                ve = get_voice_engine()
                if ve:
                    ve.disarm()
                await broadcast_event_async({"type": "voice_cancel"})

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
    _ws_server = await websockets.serve(
        handle_connection,
        host,
        port,
        max_size=16 * 1024 * 1024,
    )
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
