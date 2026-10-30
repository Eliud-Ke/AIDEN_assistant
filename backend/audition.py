"""
AIDEN Assistant - STT Push-to-Talk Audition (Hold Shift to Speak)
Test script for Google Keyless Chromium STT using a global Push-To-Talk shortcut.

Usage:
  1. Run this script in your terminal:
     backend\\venv\\Scripts\\python.exe backend\\audition.py
  2. Hold down either SHIFT key and speak (take your time, say 'uhmm', etc.).
  3. Release the SHIFT key when you're finished.
  4. Audio is transcribed via Google's free keyless endpoint with latency metrics.
  5. Press Ctrl+C to quit.
"""

import io
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


def record_while_key_pressed(key: str = "shift"):
    """
    Waits for the key to be pressed down, streams audio from the microphone
    into RAM, and stops the recording immediately when the key is released.
    """
    # 1. Wait for key press
    while not keyboard.is_pressed(key):
        time.sleep(0.01)

    print(f"\n🔴 [LISTENING...] Key '{key.upper()}' held. Speak now! (Release to transcribe)")

    audio_chunks = []

    def callback(indata, frames, time_info, status):
        audio_chunks.append(indata.copy())

    # Open microphone stream (16kHz 16-bit mono)
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16",
        callback=callback,
        blocksize=1024,
    )

    start_time = time.time()
    with stream:
        # Keep recording as long as the key remains pressed down
        while keyboard.is_pressed(key):
            time.sleep(0.01)

    duration = time.time() - start_time
    print(f"⏹️  [RELEASED] Captured {duration:.2f}s of audio. Transcribing...")

    if not audio_chunks:
        return None, duration

    full_audio = np.concatenate(audio_chunks, axis=0)
    return full_audio, duration


def transcribe_google_free(audio_np: np.ndarray, sample_rate: int = SAMPLE_RATE) -> tuple[str, float]:
    """Transcribes audio using Google's Keyless Chromium Endpoint (Free, 0 API keys)."""
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
    print("=" * 74)
    print(" AIDEN ASSISTANT - PUSH-TO-TALK STT AUDITION (GOOGLE KEYLESS)")
    print("=" * 74)
    print("Workflow:")
    print("  • HOLD either Shift key down and speak (take your time, say 'uhmm', etc.)")
    print("  • RELEASE Shift as soon as you're done speaking.")
    print("  • Audio is sent to Google's keyless speech endpoint (100% free, 0 API key).")
    print("  • Press Ctrl+C in this window at any time to exit.")
    print("=" * 74)

    test_num = 1
    while True:
        try:
            print(f"\n[Test #{test_num}] Ready! Press and HOLD 'SHIFT' to speak...")
            audio_data, duration = record_while_key_pressed("shift")

            if audio_data is None or len(audio_data) < SAMPLE_RATE * 0.3:
                print("⚠️ Utterance too short (< 0.3s). Try speaking for at least 1-2 seconds.")
                time.sleep(0.4)
                continue

            print("⏳ Transcribing with Google Keyless endpoint...")
            google_text, latency = transcribe_google_free(audio_data)

            print("\n" + "-" * 74)
            print(f"📊 TRANSCRIPTION RESULT:")
            print(f"  🗣️  Text:    \"{google_text}\"")
            print(f"  ⏱️  Latency: {latency:.2f}s")
            print(f"  🎙️  Audio:   {duration:.2f}s")
            print("-" * 74)

            test_num += 1
            # Wait for user to fully let go of Shift before next prompt
            while keyboard.is_pressed("shift"):
                time.sleep(0.05)
            time.sleep(0.3)

        except KeyboardInterrupt:
            print("\n\nSTT Audition ended. Goodbye!")
            break


if __name__ == "__main__":
    main()
