"""
AIDEN Assistant - OpenAI TTS-1 Voice Audition
Audition all official OpenAI `tts-1` voices using real-time chunk streaming.
"""

import os
import sys
from pathlib import Path

# Ensure UTF-8 output on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Add backend directory to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from auth_manager import get_api_key
except ImportError:
    get_api_key = lambda: os.environ.get("OPENAI_API_KEY")

import openai

AUDITION_TEXT = (
    "Hello! I am Aiden, your desktop assistant. I can search through your local files, "
    "answer complex questions, control your media playback, and draft emails whenever you need a hand. "
    "Running quietly right on your machine, I aim to keep your workflow fast, seamless, and completely natural. "
    "Tell me, how does my voice sound to you?"
)

OUTPUT_DIR = Path(__file__).resolve().parent / "auditions"

# All official OpenAI TTS-1 voices
CANDIDATE_VOICES = [
    {
        "id": "nova",
        "gender": "Female",
        "style": "Warm, lively, energetic conversational assistant (ChatGPT favorite)",
    },
    {
        "id": "shimmer",
        "gender": "Female",
        "style": "Clear, bright, articulate, and optimistic assistant tone",
    },
    {
        "id": "alloy",
        "gender": "Neutral / Female",
        "style": "Balanced, modern, crisp, and versatile tone",
    },
    {
        "id": "fable",
        "gender": "Female / Expressive",
        "style": "British-inflected, expressive, and narrative tone",
    },
    {
        "id": "echo",
        "gender": "Male",
        "style": "Warm, calm, grounded, and conversational tone",
    },
    {
        "id": "onyx",
        "gender": "Male",
        "style": "Deep, authoritative, resonant, and smooth tone",
    },
]


def stream_voice_sample(client: openai.OpenAI, voice_id: str, text: str, output_path: Path):
    """
    Streams raw audio byte chunks directly from OpenAI tts-1 without waiting
    for the whole download to finish, saving to disk and measuring latency.
    """
    with client.audio.speech.with_streaming_response.create(
        model="tts-1",
        voice=voice_id,
        input=text,
        response_format="mp3",
    ) as response:
        with open(output_path, "wb") as f:
            chunk_count = 0
            total_bytes = 0
            for chunk in response.iter_bytes(chunk_size=4096):
                f.write(chunk)
                chunk_count += 1
                total_bytes += len(chunk)
    return total_bytes, chunk_count


def generate_all_samples():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    api_key = get_api_key() or os.environ.get("OPENAI_API_KEY")

    if not api_key:
        print("❌ Error: No OpenAI API Key found in vault or OPENAI_API_KEY environment variable.")
        return []

    client = openai.OpenAI(api_key=api_key)

    print("=" * 72)
    print(" AIDEN ASSISTANT - OPENAI TTS-1 REAL-TIME STREAMING AUDITION")
    print("=" * 72)
    print(f"\nSentence:\n\"{AUDITION_TEXT}\"\n")
    print("-" * 72)

    generated = []
    for idx, v in enumerate(CANDIDATE_VOICES, start=1):
        filename = f"openai_tts1_{idx:02d}_{v['id']}.mp3"
        out_file = OUTPUT_DIR / filename
        print(f"[{idx}/{len(CANDIDATE_VOICES)}] Streaming '{v['id']}' ({v['gender']}) - {v['style']}...")
        try:
            total_bytes, chunks = stream_voice_sample(client, v["id"], AUDITION_TEXT, out_file)
            size_kb = total_bytes / 1024
            print(f"    -> Complete! {chunks} streamed chunks ({size_kb:.1f} KB) -> {filename}")
            generated.append((idx, v, out_file))
        except Exception as e:
            print(f"    -> Error generating {v['id']}: {e}")

    print("\n" + "=" * 72)
    print(" ALL SAMPLES STREAMED & READY TO AUDITION!")
    print("=" * 72)
    return generated


def interactive_player(samples):
    print("\nYou can now audition each voice.")
    print("Enter the voice number (1-6) to play, 'list' to view info, or 'q' to quit.")

    while True:
        try:
            choice = input("\nSelect voice to play (1-6, q to quit): ").strip().lower()
            if choice in ("q", "quit", "exit"):
                print("Audition closed.")
                break
            if choice == "list":
                for idx, v, _ in samples:
                    print(f"  [{idx}] {v['id'].upper()} ({v['gender']}): {v['style']}")
                continue
            if not choice.isdigit():
                print("Please enter a number between 1 and 6, or 'q'.")
                continue

            num = int(choice)
            matched = next((item for item in samples if item[0] == num), None)
            if not matched:
                print(f"Voice #{num} not found. Choose 1 to {len(samples)}.")
                continue

            _, v, out_path = matched
            print(f"▶ Playing [{num}] {v['id'].upper()} ({v['gender']})...")
            os.startfile(str(out_path))
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            break


def main():
    samples = generate_all_samples()
    if sys.stdin.isatty():
        interactive_player(samples)
    else:
        print("\nSummary of Generated Samples:")
        for idx, v, out_file in samples:
            print(f"  [{idx}] {v['id'].upper()} ({v['gender']}): {out_file.name}")


if __name__ == "__main__":
    main()
