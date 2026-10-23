import os
import sys
import time
import threading
from pathlib import Path
import numpy as np

# Ensure Windows stdout/stderr handles UTF-8 cleanly
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

try:
    from openwakeword.model import Model
except ImportError:
    Model = None

# Audio backends: sounddevice and pyaudio both available in Python 3.12
try:
    import sounddevice as sd
except ImportError:
    sd = None

try:
    import pyaudio
except ImportError:
    pyaudio = None


def get_model_path() -> str:
    """Resolves the absolute path to aiden.onnx or aiden.tflite (supports dev and PyInstaller)."""
    candidate_dirs = []
    if hasattr(sys, "_MEIPASS"):
        candidate_dirs.append(Path(sys._MEIPASS))
    candidate_dirs.append(Path(__file__).resolve().parent)
    candidate_dirs.append(Path(sys.executable).resolve().parent)
    candidate_dirs.append(Path(sys.executable).resolve().parent / "_internal")

    for base_dir in candidate_dirs:
        onnx_path = base_dir / "models" / "aiden.onnx"
        if onnx_path.exists():
            return str(onnx_path)

        tflite_path = base_dir / "models" / "aiden.tflite"
        if tflite_path.exists():
            return str(tflite_path)

    raise FileNotFoundError(
        f"Wake word model not found in {[str(d / 'models') for d in candidate_dirs]}. Expected 'aiden.onnx' or 'aiden.tflite'."
    )


def listen_for_wake_word(wake_word_event: threading.Event,
                         assistant_busy_event: threading.Event,
                         stop_event: threading.Event,
                         confidence_threshold: float = 0.8,
                         verbose: bool = False):
    """
    Background worker thread that listens for the wake word 'Aiden'.
    Yields the microphone whenever assistant_busy_event is set.
    """
    if Model is None:
        print("❌ [Wake Word Thread] 'openwakeword' is not installed.")
        return

    model_path = get_model_path()
    framework = "onnx" if model_path.endswith(".onnx") else "tflite"

    print(f"👂 [Wake Word Engine] Loading '{Path(model_path).name}' ({framework.upper()})...")
    oww_model = Model(wakeword_models=[model_path], inference_framework=framework)

    RATE = 16000
    CHUNK = 1280  # 80ms audio window required by OpenWakeWord

    if sd is not None:
        _listen_with_sounddevice(
            oww_model, wake_word_event, assistant_busy_event, stop_event,
            RATE, CHUNK, confidence_threshold, verbose
        )
    elif pyaudio is not None:
        _listen_with_pyaudio(
            oww_model, wake_word_event, assistant_busy_event, stop_event,
            RATE, CHUNK, confidence_threshold, verbose
        )
    else:
        print("❌ [Wake Word Thread] Neither 'sounddevice' nor 'pyaudio' is available for mic capture.")


def _listen_with_sounddevice(oww_model, wake_word_event, assistant_busy_event, stop_event,
                             rate, chunk, threshold, verbose):
    """SoundDevice audio capture loop."""
    print("✅ [Wake Word Engine] Online using SoundDevice backend.")

    while not stop_event.is_set():
        if assistant_busy_event.is_set():
            time.sleep(0.1)
            continue

        print("👂 [Wake Word Engine] 💤 Sleeping... Listening for 'Aiden'...")

        try:
            with sd.InputStream(samplerate=rate, channels=1, dtype='int16') as stream:
                while not stop_event.is_set() and not assistant_busy_event.is_set():
                    audio_chunk, overflowed = stream.read(chunk)
                    if overflowed and verbose:
                        print("⚠️ [Wake Word Engine] Input overflow.")

                    audio_data = audio_chunk.flatten()
                    oww_model.predict(audio_data)

                    for mdl in oww_model.prediction_buffer.keys():
                        score = oww_model.prediction_buffer[mdl][-1]

                        if verbose:
                            print(f"Live Confidence: {score:.4f}     ", end="\r")

                        if score > threshold:
                            print(f"\n🚨 [Wake Word Engine] WAKE WORD DETECTED! (Confidence: {score:.2f})")
                            oww_model.reset()
                            # 1. Yield microphone hardware
                            assistant_busy_event.set()
                            # 2. Fire wake signal to main loop
                            wake_word_event.set()
                            break
        except Exception as e:
            if not stop_event.is_set():
                print(f"⚠️ [Wake Word Engine] Stream error: {e}")
                time.sleep(0.5)

    print("🛑 [Wake Word Engine] SoundDevice loop exited cleanly.")


def _listen_with_pyaudio(oww_model, wake_word_event, assistant_busy_event, stop_event,
                         rate, chunk, threshold, verbose):
    """PyAudio audio capture loop."""
    print("✅ [Wake Word Engine] Online using PyAudio backend.")
    p = pyaudio.PyAudio()

    try:
        while not stop_event.is_set():
            if assistant_busy_event.is_set():
                time.sleep(0.1)
                continue

            print("👂 [Wake Word Engine] 💤 Sleeping... Listening for 'Aiden'...")

            mic_stream = None
            try:
                mic_stream = p.open(format=pyaudio.paInt16, channels=1,
                                    rate=rate, input=True, frames_per_buffer=chunk)

                while not stop_event.is_set() and not assistant_busy_event.is_set():
                    audio_bytes = mic_stream.read(chunk, exception_on_overflow=False)
                    audio_data = np.frombuffer(audio_bytes, dtype=np.int16)

                    oww_model.predict(audio_data)

                    for mdl in oww_model.prediction_buffer.keys():
                        score = oww_model.prediction_buffer[mdl][-1]

                        if verbose:
                            print(f"Live Confidence: {score:.4f}     ", end="\r")

                        if score > threshold:
                            print(f"\n🚨 [Wake Word Engine] WAKE WORD DETECTED! (Confidence: {score:.2f})")
                            oww_model.reset()
                            assistant_busy_event.set()
                            wake_word_event.set()
                            break
            except Exception as e:
                if not stop_event.is_set():
                    print(f"⚠️ [Wake Word Engine] Stream error: {e}")
                    time.sleep(0.5)
            finally:
                if mic_stream is not None:
                    try:
                        mic_stream.stop_stream()
                        mic_stream.close()
                    except Exception:
                        pass
    finally:
        p.terminate()
        print("🛑 [Wake Word Engine] PyAudio instance terminated cleanly.")


def start_wake_word_engine(wake_word_event: threading.Event,
                           assistant_busy_event: threading.Event,
                           stop_event: threading.Event,
                           confidence_threshold: float = 0.8,
                           verbose: bool = False) -> threading.Thread:
    """Spins up the wake word listener as a managed background daemon thread."""
    thread = threading.Thread(
        target=listen_for_wake_word,
        args=(wake_word_event, assistant_busy_event, stop_event, confidence_threshold, verbose),
        daemon=True,
        name="WakeWordListenerThread"
    )
    thread.start()
    return thread


if __name__ == '__main__':
    wake_event = threading.Event()
    busy_event = threading.Event()
    stop_sig = threading.Event()

    print("--- TESTING WAKE WORD ENGINE STANDALONE ---")
    t = start_wake_word_engine(wake_event, busy_event, stop_sig, verbose=True)

    try:
        while True:
            if wake_event.is_set():
                print("\n[Main Thread] 🎉 Caught wake event! Aiden is awake.")
                wake_event.clear()

                print("[Main Thread] Simulating 5 seconds of active conversation/work...")
                time.sleep(5)

                print("[Main Thread] Done. Returning to sleep mode...\n")
                busy_event.clear()

            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nStopping wake word test...")
        stop_sig.set()
        t.join(timeout=2.0)
        print("Test finished.")
