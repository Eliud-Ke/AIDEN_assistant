"""
AIDEN Assistant - Real-Time Audio Amplitude & STT Test Engine
Demonstrates simultaneous real-time volume/waveform metering + Google Keyless STT on a single mic stream.

Usage:
  backend\\venv\\Scripts\\python.exe backend\\test_engine.py
"""

import io
import math
import os
import sys
import time

# UTF-8 Windows terminal support
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import keyboard
import numpy as np
import scipy.io.wavfile as wavfile
import sounddevice as sd
import speech_recognition as sr

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 512  # ~32ms per audio slice for ultra-smooth ~30-60 FPS visualizer updates


def render_meter_bar(level: float, width: int = 25) -> str:
    """Renders a smooth visual progress bar for audio amplitude (0.0 to 1.0)."""
    filled_len = int(round(width * max(0.0, min(1.0, level))))
    empty_len = width - filled_len
    return "█" * filled_len + "░" * empty_len


def calculate_band_energies(audio_chunk: np.ndarray, sample_rate: int = SAMPLE_RATE):
    """
    Computes a 3-band frequency distribution (Bass, Mid, High)
    using real-time Fast Fourier Transform (FFT).
    """
    if len(audio_chunk) < 64:
        return 0.0, 0.0, 0.0

    # Apply Hanning window to prevent spectral leakage
    windowed = audio_chunk.astype(np.float32) * np.hanning(len(audio_chunk))
    fft_vals = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(audio_chunk), 1.0 / sample_rate)

    # Frequency ranges
    # Bass: 50Hz - 250Hz
    # Mid: 250Hz - 2000Hz
    # High: 2000Hz - 8000Hz
    bass_mask = (freqs >= 50) & (freqs < 250)
    mid_mask = (freqs >= 250) & (freqs < 2000)
    high_mask = (freqs >= 2000) & (freqs < 8000)

    bass = np.mean(fft_vals[bass_mask]) if np.any(bass_mask) else 0.0
    mid = np.mean(fft_vals[mid_mask]) if np.any(mid_mask) else 0.0
    high = np.mean(fft_vals[high_mask]) if np.any(high_mask) else 0.0

    # Normalize to roughly 0.0 - 1.0
    bass_norm = min(1.0, bass / 180000.0)
    mid_norm = min(1.0, mid / 120000.0)
    high_norm = min(1.0, high / 60000.0)

    return bass_norm, mid_norm, high_norm


def record_and_visualize(key: str = "shift"):
    """
    Waits for the Shift key, captures audio chunks for STT, and simultaneously
    calculates & prints real-time volume fluctuations to the console at 30+ FPS.
    """
    # 1. Wait for Shift key to be pressed
    while not keyboard.is_pressed(key):
        time.sleep(0.01)

    print(f"\n🔴 [RECORDING...] Key '{key.upper()}' is pressed. Speak into your microphone!")
    print("--------------------------------------------------------------------------------")

    audio_chunks = []
    volume_history = []
    last_print_time = 0.0

    def audio_callback(indata, frames, time_info, status):
        nonlocal last_print_time
        # A) Accumulate raw audio for final speech transcription
        audio_chunks.append(indata.copy())

        # B) Simultaneously compute volume and sound wave amplitude
        float_data = indata.astype(np.float32)
        rms = float(np.sqrt(np.mean(float_data ** 2)))
        peak = float(np.max(np.abs(float_data)))

        # Normalize RMS (voice typically sits between 200 and 10000 on standard 16-bit mics)
        # Using logarithmic perception curve (dB-like scaling for human hearing)
        if rms > 10.0:
            # Perceptual logarithmic scaling
            level = min(1.0, math.log10(rms / 10.0) / 3.0)
        else:
            level = 0.0

        volume_history.append(level)

        # C) Compute 3 frequency bands
        bass, mid, high = calculate_band_energies(indata.flatten())

        # Throttled console display at ~30 FPS (~33ms) so terminal updates are crisp
        now = time.time()
        if now - last_print_time >= 0.033:
            last_print_time = now
            meter = render_meter_bar(level, width=22)
            pct = int(level * 100)
            
            # Interactive dynamic status line matching vocal loudness
            indicator = "🔊 LOUD   " if pct > 65 else ("🔉 SPEAKING" if pct > 20 else "🔈 QUIET   ")
            
            # Print single in-place line with carriage return \r
            sys.stdout.write(
                f"\r🎙️ Amplitude: [{meter}] {pct:3d}%  {indicator} | Low:{int(bass*100):2d}% Mid:{int(mid*100):2d}% Hi:{int(high*100):2d}%"
            )
            sys.stdout.flush()

    # Open microphone stream (16kHz 16-bit mono)
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16",
        callback=audio_callback,
        blocksize=BLOCK_SIZE,
    )

    start_time = time.time()
    with stream:
        # Loop while key is continuously held
        while keyboard.is_pressed(key):
            time.sleep(0.005)

    duration = time.time() - start_time
    print("\n--------------------------------------------------------------------------------")
    print(f"⏹️  [RELEASED] Captured {duration:.2f}s of audio with live amplitude tracking.")

    if not audio_chunks:
        return None, duration, 0.0, 0.0

    full_audio = np.concatenate(audio_chunks, axis=0)
    avg_vol = float(np.mean(volume_history)) * 100 if volume_history else 0.0
    peak_vol = float(np.max(volume_history)) * 100 if volume_history else 0.0

    return full_audio, duration, avg_vol, peak_vol


def transcribe_google_free(audio_np: np.ndarray, sample_rate: int = SAMPLE_RATE) -> tuple[str, float]:
    """Transcribes the captured buffer using Google's Keyless Chromium Endpoint."""
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
        return text, latency
    except sr.UnknownValueError:
        return "[Could not understand audio / silence]", time.time() - t0
    except sr.RequestError as e:
        return f"[Google STT Service Error: {e}]", time.time() - t0


def main():
    print("=" * 80)
    print(" AIDEN ASSISTANT - REAL-TIME AMPLITUDE & STT ENGINE")
    print("=" * 80)
    print("How to test:")
    print("  1. Press and HOLD the 'SHIFT' key down.")
    print("  2. Watch the live volume bar and Low / Mid / High frequency bands fluctuate.")
    print("  3. Speak softly, speak loudly, or pause to see how the meter reacts in real time.")
    print("  4. RELEASE the 'SHIFT' key when you finish.")
    print("  5. The captured audio is immediately transcribed by Google's keyless STT.")
    print("  6. Press Ctrl+C in this terminal at any time to exit.")
    print("=" * 80)

    turn_count = 1
    while True:
        try:
            print(f"\n[Test #{turn_count}] Ready. Press and HOLD 'SHIFT' to speak...")
            audio_data, duration, avg_vol, peak_vol = record_and_visualize("shift")

            if audio_data is None or len(audio_data) < SAMPLE_RATE * 0.3:
                print("⚠️ Speech was too short (< 0.3s). Try speaking for at least 1-2 seconds.")
                time.sleep(0.4)
                continue

            print("⏳ Transcribing audio buffer via Google Keyless Endpoint...")
            text, latency = transcribe_google_free(audio_data)

            print("\n" + "=" * 80)
            print("📊 FINAL RESULTS & AUDIO METRICS:")
            print(f"  🗣️  Transcribed: \"{text}\"")
            print(f"  ⏱️  Transcription Latency: {latency:.2f}s")
            print(f"  🎙️  Audio Duration:        {duration:.2f}s")
            print(f"  📈  Peak Volume Level:     {peak_vol:.1f}%")
            print(f"  📊  Average Volume Level:  {avg_vol:.1f}%")
            print("=" * 80)

            turn_count += 1
            # Wait for user to let go of Shift key before priming next round
            while keyboard.is_pressed("shift"):
                time.sleep(0.05)
            time.sleep(0.3)

        except KeyboardInterrupt:
            print("\n\nExiting test engine. Goodbye!")
            break


if __name__ == "__main__":
    main()

