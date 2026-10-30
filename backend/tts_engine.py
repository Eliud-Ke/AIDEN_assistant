"""
AIDEN Assistant - OpenAI TTS-1 In-RAM Streaming Engine
Cleans markdown, emojis, URLs, and symbols for natural speech synthesis and returns Base64 MP3.
"""

import asyncio
import base64
import io
import os
import re
import unicodedata
import openai

try:
    from auth_manager import get_api_key
except ImportError:
    try:
        from backend.auth_manager import get_api_key
    except ImportError:
        get_api_key = lambda: os.environ.get("OPENAI_API_KEY")

DEFAULT_VOICE = "nova"
DEFAULT_MODEL = "tts-1"


def clean_text_for_speech(raw_text: str) -> str:
    """
    Strips raw markdown syntax, code blocks, URLs, emojis, icons, and formatting tokens
    so OpenAI Nova generates clean, conversational, natural-sounding speech without
    announcing emojis, symbols, or code out loud.
    """
    if not raw_text:
        return ""

    text = raw_text

    # 1. Remove fenced code blocks (```python ... ```)
    text = re.sub(r"```[\w-]*\n[\s\S]*?```", " Code snippet omitted. ", text)
    # Remove inline code (`code`)
    text = re.sub(r"`([^`]+)`", r"\1", text)

    # 2. Convert markdown links [Label](url) -> Label
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)

    # 3. Remove raw URLs
    text = re.sub(r"https?://\S+|www\.\S+", "", text)

    # 4. Remove images ![alt](url)
    text = re.sub(r"!\[[^\]]*\]\([^\)]+\)", "", text)

    # 5. Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)

    # 6. Remove Markdown headers (#, ##, etc.)
    text = re.sub(r"^\s*#{1,6}\s*", "", text, flags=re.MULTILINE)

    # 7. Remove bold, italic, strikethrough (**, *, __, _, ~~)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)

    # 8. Remove list markers (-, *, +, bullet, etc.) at the beginning of lines
    text = re.sub(r"^\s*[-*+•–—]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)

    # 9. Remove blockquotes (> )
    text = re.sub(r"^\s*>\s*", "", text, flags=re.MULTILINE)

    # 10. Remove markdown table formatting characters (|)
    text = re.sub(r"\|", " ", text)
    text = re.sub(r"[-:]{3,}", "", text)

    # 11. Strip ALL Unicode Emojis, Pictographs, and Decorative Symbols
    cleaned_chars = []
    for ch in text:
        cat = unicodedata.category(ch)
        cp = ord(ch)
        # Drop emoji / symbol other (So), symbol modifier (Sk), variation selectors (Mn for FE00-FE0F)
        if cat in ("So", "Sk"):
            continue
        if 0xFE00 <= cp <= 0xFE0F or cp in (0x200D, 0x200C):
            continue
        # Drop decorative bullets & non-ascii arrows/math symbols
        if cat == "Sm" and cp > 127:
            continue
        if cp in (0x2022, 0x2023, 0x25E6, 0x2043, 0x2219):
            continue
        # Supplementary pictographic / emoji planes (U+1F000 to U+1FFFF)
        if 0x1F000 <= cp <= 0x1FFFF:
            continue
        cleaned_chars.append(ch)
    text = "".join(cleaned_chars)

    # 12. Remove common text emoticons like :-), :), :D, :P, :-(, etc.
    text = re.sub(r"(?<=\s)[:;]-?[)(DPp03Oo/\\|](?=\s|$)", "", text)

    # 13. Fix spacing before punctuation (e.g. 'Hello ! ' -> 'Hello! ')
    text = re.sub(r"\s+([,.:;?!])", r"\1", text)
    # Remove duplicate consecutive punctuation like '..', '!!'
    text = re.sub(r"([,.:;?!])\1+", r"\1", text)

    # 14. Normalize multiple newlines, whitespace, and empty punctuation
    text = re.sub(r"\s+", " ", text).strip()

    return text


async def synthesize_speech_base64(
    text: str, voice: str = DEFAULT_VOICE, model: str = DEFAULT_MODEL
) -> str:
    """
    Synthesizes conversational assistant speech directly in RAM using OpenAI's tts-1.
    Streams chunks into an in-memory buffer without disk writes and returns the MP3 as a base64 string.
    """
    clean_text = clean_text_for_speech(text)
    if not clean_text:
        clean_text = "There is no readable text to speak."

    api_key = get_api_key() or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("No OpenAI API key found in vault or environment variables.")

    loop = asyncio.get_running_loop()

    def _sync_stream():
        client = openai.OpenAI(api_key=api_key)
        audio_buffer = io.BytesIO()
        with client.audio.speech.with_streaming_response.create(
            model=model,
            voice=voice,
            input=clean_text,
            response_format="mp3",
        ) as response:
            for chunk in response.iter_bytes(chunk_size=4096):
                audio_buffer.write(chunk)
        return audio_buffer.getvalue()

    raw_bytes = await loop.run_in_executor(None, _sync_stream)
    if not raw_bytes:
        raise RuntimeError("No audio data produced by OpenAI TTS.")

    return base64.b64encode(raw_bytes).decode("ascii")


if __name__ == "__main__":
    sample = (
        "🚀 Hey Eliud! 🤖 Nova is now active in Aiden. "
        "Everything runs through in-RAM chunk streaming! ✨ Check this out: [Guide](https://aiden.ai). 👍"
    )
    cleaned = clean_text_for_speech(sample)
    print("Cleaned text:", cleaned)
    b64 = asyncio.run(synthesize_speech_base64(cleaned))
    print(f"Generated Base64 length: {len(b64)} chars (approx {len(b64) * 3 / 4 / 1024:.1f} KB)")
