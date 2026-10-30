"""
AIDEN Assistant - Voice Engine & Real-Time Audio Meter
Provides simultaneous real-time audio amplitude/frequency metering + Google Keyless STT.
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

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 512  # ~32ms per audio slice for smooth ~30 FPS updates
SILENCE_TIMEOUT = 1.3  # Seconds of silence after speech before auto-finalizing
MIN_SPEECH_DURATION = 0.35  # Minimum seconds of audio to attempt transcription


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


def transcribe_google_free(audio_np: np.ndarray, sample_rate: int = SAMPLE_RATE) -> tuple[str, float]:
    """Transcribes captured audio buffer using Google's Keyless Chromium Endpoint."""
    t0 = time.time()
    buf = io.BytesIO()
    wavfile.write(buf, sample_rate, audio_np)
    buf.seek(0)

    recognizer = sr.Recognizer()
    with sr.AudioFile(buf) as source:
        audio_data = recognizer.record(source)

    try:
        text = recognizer.recognize_google(audio_data, language="en-US")
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
    """Manages microphone input, real-time audio metering, and speech transcription."""

    def __init__(self,
                 on_meter: Optional[Callable[[float, float, float, float], None]] = None,
                 on_transcription: Optional[Callable[[str], None]] = None,
                 on_status: Optional[Callable[[str], None]] = None,
                 loop: Optional[asyncio.AbstractEventLoop] = None):
        self.on_meter = on_meter
        self.on_transcription = on_transcription
        self.on_status = on_status
        self.loop = loop

        self.is_listening = False
        self._stream: Optional[sd.InputStream] = None
        self._audio_chunks: list[np.ndarray] = []
        self._speech_detected = False
        self._last_speech_time = 0.0
        self._start_time = 0.0
        self._last_meter_emit = 0.0
        self._lock = threading.Lock()
        self._is_finalizing = False

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

    def start_listening(self):
        """Starts real-time microphone capture and volume metering."""
        with self._lock:
            if self.is_listening:
                return

            self._audio_chunks = []
            self._speech_detected = False
            self._last_speech_time = time.time()
            self._start_time = time.time()
            self._last_meter_emit = 0.0
            self._is_finalizing = False
            self.is_listening = True

            try:
                self._stream = sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    channels=CHANNELS,
                    dtype="int16",
                    callback=self._audio_callback,
                    blocksize=BLOCK_SIZE,
                )
                self._stream.start()
                print("🎙️ [VOICE ENGINE] Microphone stream active. Listening...")
                self._dispatch(self.on_status, "listening")
            except Exception as e:
                print(f"❌ [VOICE ENGINE] Failed to open microphone stream: {e}")
                self.is_listening = False
                self._stream = None
                self._dispatch(self.on_status, "error")

    def _audio_callback(self, indata, frames, time_info, status):
        """Callback running on SoundDevice real-time audio thread."""
        if not self.is_listening or self._is_finalizing:
            return

        chunk = indata.copy()
        self._audio_chunks.append(chunk)

        float_data = indata.astype(np.float32)
        rms = float(np.sqrt(np.mean(float_data ** 2)))
        level = min(1.0, math.log10(rms / 10.0) / 3.0) if rms > 10.0 else 0.0
        bass, mid, high = calculate_band_energies(indata.flatten())

        now = time.time()

        # VAD detection
        if level > 0.16 or rms > 30.0:
            self._speech_detected = True
            self._last_speech_time = now

        # Throttled live meter broadcast (~30 FPS)
        if now - self._last_meter_emit >= 0.033:
            self._last_meter_emit = now
            if self.on_meter:
                self._dispatch(self.on_meter, level, bass, mid, high)

        # Automatic silence finalization after speech
        elapsed = now - self._start_time
        silence_duration = now - self._last_speech_time
        if self._speech_detected and silence_duration >= SILENCE_TIMEOUT and elapsed >= MIN_SPEECH_DURATION:
            self._is_finalizing = True
            threading.Thread(target=self._finalize_recording, daemon=True).start()

    def stop_listening(self, and_transcribe: bool = True):
        """Stops the audio stream and optionally triggers speech transcription."""
        with self._lock:
            if not self.is_listening:
                return
            self.is_listening = False

            if self._stream:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None

        if and_transcribe:
            threading.Thread(target=self._finalize_recording, daemon=True).start()
        else:
            self._dispatch(self.on_status, "idle")

    def _finalize_recording(self):
        """Transcribes accumulated audio buffer in background thread."""
        with self._lock:
            self.is_listening = False
            if self._stream:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None

            chunks = list(self._audio_chunks)
            self._audio_chunks = []
            self._is_finalizing = False

        if not chunks:
            self._dispatch(self.on_status, "idle")
            return

        full_audio = np.concatenate(chunks, axis=0)
        duration = len(full_audio) / SAMPLE_RATE

        if duration < MIN_SPEECH_DURATION or not self._speech_detected:
            print(f"🎙️ [VOICE ENGINE] Audio too short ({duration:.2f}s) or silence. Ignoring.")
            self._dispatch(self.on_status, "idle")
            return

        print(f"⏳ [VOICE ENGINE] Transcribing {duration:.2f}s audio buffer via Google Keyless STT...")
        self._dispatch(self.on_status, "transcribing")

        text, latency = transcribe_google_free(full_audio)

        if text:
            print(f"✨ [VOICE ENGINE] Transcribed (latency={latency:.2f}s): \"{text}\"")
            self._dispatch(self.on_transcription, text)
        else:
            print("🎙️ [VOICE ENGINE] No recognizable speech detected.")
            self._dispatch(self.on_status, "idle")


# Global singleton instance
voice_engine: Optional[VoiceEngine] = None


def get_voice_engine() -> Optional[VoiceEngine]:
    return voice_engine


def init_voice_engine(on_meter=None, on_transcription=None, on_status=None, loop=None) -> VoiceEngine:
    global voice_engine
    voice_engine = VoiceEngine(on_meter=on_meter, on_transcription=on_transcription, on_status=on_status, loop=loop)
    return voice_engine
