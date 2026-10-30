"""
AIDEN Assistant - Voice Engine & Real-Time Audio Meter
Provides Push-to-Talk (Hold Shift to speak, release to send) + Real-Time Audio Metering + Google Keyless STT.
Zero VAD / silence complications: purely controlled by holding Shift or frontend Push-to-Talk.
"""

import asyncio
import io
import math
import threading
import time
from typing import Callable, Optional

import numpy as np
import scipy.io.wavfile as wavfile
import sounddevice as sd
import speech_recognition as sr

import ctypes
import sys

try:
    import keyboard
except ImportError:
    keyboard = None

IS_WINDOWS = sys.platform == "win32"
if IS_WINDOWS:
    _user32 = ctypes.windll.user32
    _VK_SHIFT = 0x10

    def is_shift_down() -> bool:
        """Instant Win32 keyboard register check (<0.001ms, zero hook delay)."""
        return bool(_user32.GetAsyncKeyState(_VK_SHIFT) & 0x8000)
else:
    def is_shift_down() -> bool:
        return keyboard.is_pressed("shift") if keyboard else False

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 512  # ~32ms per audio slice for ultra-smooth ~30 FPS updates
MIN_SPEECH_DURATION = 0.35  # Ignore taps shorter than 350ms (e.g. typing capital letters)


def calculate_band_energies(audio_chunk: np.ndarray, sample_rate: int = SAMPLE_RATE) -> tuple[float, float, float]:
    """Computes a 3-band frequency distribution (Bass, Mid, High) via FFT."""
    if len(audio_chunk) < 64:
        return 0.0, 0.0, 0.0

    windowed = audio_chunk.astype(np.float32) * np.hanning(len(audio_chunk))
    fft_vals = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(audio_chunk), 1.0 / sample_rate)

    bass_mask = (freqs >= 50) & (freqs < 250)
    mid_mask = (freqs >= 250) & (freqs < 2000)
    high_mask = (freqs >= 2000) & (freqs < 8000)

    bass = float(np.mean(fft_vals[bass_mask])) if np.any(bass_mask) else 0.0
    mid = float(np.mean(fft_vals[mid_mask])) if np.any(mid_mask) else 0.0
    high = float(np.mean(fft_vals[high_mask])) if np.any(high_mask) else 0.0

    bass_norm = min(1.0, bass / 180000.0)
    mid_norm = min(1.0, mid / 120000.0)
    high_norm = min(1.0, high / 60000.0)

    return bass_norm, mid_norm, high_norm


_shared_recognizer = sr.Recognizer()


def transcribe_google_free(audio_np: np.ndarray, sample_rate: int = SAMPLE_RATE) -> tuple[str, float]:
    """Transcribes captured audio buffer directly via Google Keyless STT with zero WAV encoding overhead."""
    t0 = time.time()
    if audio_np.dtype != np.int16:
        audio_int16 = (audio_np * 32767).astype(np.int16)
    else:
        audio_int16 = audio_np

    raw_bytes = audio_int16.tobytes()
    # Direct 16-bit PCM AudioData construction (0ms RAM overhead)
    audio_data = sr.AudioData(raw_bytes, sample_rate, 2)

    try:
        text = _shared_recognizer.recognize_google(audio_data, language="en-US")
        latency = time.time() - t0
        return text.strip(), latency
    except sr.UnknownValueError:
        return "", time.time() - t0
    except sr.RequestError as e:
        print(f"⚠️ [STT] Google STT service request error: {e}")
        return "", time.time() - t0
    except Exception as e:
        print(f"⚠️ [STT] Transcription error: {e}")
        return "", time.time() - t0


class VoiceEngine:
    """
    Manages push-to-talk audio capture, live metering, and transcription.
    Zero VAD: Voice mode arms/disarms cleanly. Mic is only opened while Shift
    is held down (or frontend triggers recording_start), and transcribed on release.
    """

    def __init__(self,
                 on_meter: Optional[Callable[[float, float, float, float], None]] = None,
                 on_transcription: Optional[Callable[[str], None]] = None,
                 on_status: Optional[Callable[[str], None]] = None,
                 on_active: Optional[Callable[[bool], None]] = None,
                 on_recording: Optional[Callable[[bool], None]] = None,
                 loop: Optional[asyncio.AbstractEventLoop] = None):
        self.on_meter = on_meter
        self.on_transcription = on_transcription
        self.on_status = on_status
        self.on_active = on_active
        self.on_recording = on_recording
        self.loop = loop

        self.is_armed = False
        self.is_recording = False
        self._stream: Optional[sd.InputStream] = None
        self._audio_chunks: list[np.ndarray] = []
        self._start_time = 0.0
        self._last_meter_emit = 0.0
        self._lock = threading.Lock()
        self._stop_monitor = threading.Event()

        # Start background Shift key monitor thread
        if IS_WINDOWS or keyboard is not None:
            self._start_shift_monitor()

    def _dispatch(self, fn: Optional[Callable], *args):
        """Safely dispatches callback across thread or asyncio event loop."""
        if not fn:
            return
        if self.loop and self.loop.is_running():
            try:
                self.loop.call_soon_threadsafe(fn, *args)
            except Exception:
                try:
                    fn(*args)
                except Exception:
                    pass
        else:
            try:
                fn(*args)
            except Exception:
                pass

    def _start_shift_monitor(self):
        """Monitors Shift key for Push-to-Talk in a dedicated thread."""
        self._stop_monitor.clear()
        t = threading.Thread(target=self._shift_monitor_loop, daemon=True, name="VoiceEngine-ShiftMonitor")
        t.start()

    def _shift_monitor_loop(self):
        """Loops waiting for Shift to be held down and released when voice mode is armed."""
        while not self._stop_monitor.is_set():
            try:
                if self.is_armed:
                    if is_shift_down():
                        # Shift key pressed down while armed!
                        if not self.is_recording:
                            self.start_recording(origin="shift")

                        # Keep recording while Shift is held
                        while is_shift_down() and not self._stop_monitor.is_set():
                            time.sleep(0.008)

                        # Shift key released!
                        if self.is_recording:
                            self.stop_recording(and_transcribe=True)
                time.sleep(0.01)
            except Exception:
                time.sleep(0.03)

    def arm(self):
        """Arms Voice Mode without opening the microphone."""
        with self._lock:
            self.is_armed = True
        print("🎙️ [VOICE ENGINE] Voice Mode ARMED (mic is OFF). Hold Shift to speak...")
        self._dispatch(self.on_active, True)
        self._dispatch(self.on_status, "armed")
        self._dispatch(self.on_recording, False)

    def disarm(self):
        """Disarms Voice Mode and ensures microphone is off."""
        with self._lock:
            self.is_armed = False
        if self.is_recording:
            self.stop_recording(and_transcribe=False)
        print("⏹️ [VOICE ENGINE] Voice Mode DISARMED.")
        self._dispatch(self.on_active, False)
        self._dispatch(self.on_recording, False)
        self._dispatch(self.on_status, "idle")

    def start_recording(self, origin: str = "shift"):
        """Starts real-time microphone capture and volume metering (Shift held down)."""
        with self._lock:
            if self.is_recording:
                return

            self._audio_chunks = []
            self._start_time = time.time()
            self._last_meter_emit = 0.0
            self.is_armed = True
            self.is_recording = True

            try:
                self._stream = sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    channels=CHANNELS,
                    dtype="int16",
                    callback=self._audio_callback,
                    blocksize=BLOCK_SIZE,
                )
                self._stream.start()
                print(f"🔴 [VOICE ENGINE] Microphone RECORDING ACTIVE ({origin.upper()}). Speak now...")
                self._dispatch(self.on_recording, True)
                self._dispatch(self.on_status, "recording")
            except Exception as e:
                print(f"❌ [VOICE ENGINE] Failed to open microphone stream: {e}")
                self.is_recording = False
                self._stream = None
                self._dispatch(self.on_recording, False)
                self._dispatch(self.on_status, "error")

    def _audio_callback(self, indata, frames, time_info, status):
        """Real-time audio callback calculating volume & frequency bands."""
        if not self.is_recording:
            return

        chunk = indata.copy()
        self._audio_chunks.append(chunk)

        float_data = indata.astype(np.float32)
        rms = float(np.sqrt(np.mean(float_data ** 2)))
        level = min(1.0, math.log10(rms / 10.0) / 3.0) if rms > 10.0 else 0.0
        bass, mid, high = calculate_band_energies(indata.flatten())

        now = time.time()
        # Throttled live meter broadcast (~30 FPS)
        if now - self._last_meter_emit >= 0.033:
            self._last_meter_emit = now
            if self.on_meter:
                self._dispatch(self.on_meter, level, bass, mid, high)

    def stop_recording(self, and_transcribe: bool = True):
        """Stops the audio stream and triggers transcription if audio is long enough."""
        with self._lock:
            if not self.is_recording:
                return
            self.is_recording = False

            if self._stream:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None

        self._dispatch(self.on_recording, False)
        # Reset meter bars to flat
        self._dispatch(self.on_meter, 0.0, 0.0, 0.0, 0.0)

        if and_transcribe:
            self._dispatch(self.on_status, "transcribing")
            threading.Thread(target=self._finalize_recording, daemon=True).start()
        else:
            self._dispatch(self.on_status, "armed" if self.is_armed else "idle")

    def _finalize_recording(self):
        """Processes accumulated audio buffer and sends transcription."""
        with self._lock:
            chunks = list(self._audio_chunks)
            self._audio_chunks = []

        if not chunks:
            self._dispatch(self.on_status, "armed" if self.is_armed else "idle")
            return

        full_audio = np.concatenate(chunks, axis=0)
        duration = len(full_audio) / SAMPLE_RATE

        if duration < MIN_SPEECH_DURATION:
            print(f"⚠️ [VOICE ENGINE] Key tap too short ({duration:.2f}s < {MIN_SPEECH_DURATION}s). Ignored.")
            self._dispatch(self.on_status, "armed" if self.is_armed else "idle")
            return

        print(f"⏳ [VOICE ENGINE] Transcribing {duration:.2f}s audio buffer via Google Keyless STT...")
        self._dispatch(self.on_status, "transcribing")

        text, latency = transcribe_google_free(full_audio)

        if text:
            print(f"✨ [VOICE ENGINE] Transcribed (latency={latency:.2f}s): \"{text}\"")
            self._dispatch(self.on_transcription, text)
        else:
            print("🎙️ [VOICE ENGINE] No recognizable speech detected.")
            self._dispatch(self.on_status, "armed" if self.is_armed else "idle")

    def shutdown(self):
        """Gracefully shuts down voice engine and background threads."""
        self._stop_monitor.set()
        self.stop_recording(and_transcribe=False)
        self.disarm()


# Global singleton instance
voice_engine: Optional[VoiceEngine] = None


def get_voice_engine() -> Optional[VoiceEngine]:
    return voice_engine


def init_voice_engine(on_meter=None,
                      on_transcription=None,
                      on_status=None,
                      on_active=None,
                      on_recording=None,
                      loop=None) -> VoiceEngine:
    global voice_engine
    if voice_engine is not None:
        voice_engine.shutdown()
    voice_engine = VoiceEngine(
        on_meter=on_meter,
        on_transcription=on_transcription,
        on_status=on_status,
        on_active=on_active,
        on_recording=on_recording,
        loop=loop
    )
    return voice_engine
