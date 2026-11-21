"""Language Friend voice API. Provider keys remain on the backend."""
import asyncio
import json
import os
import time
import wave
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import httpx
from dotenv import dotenv_values, load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from audio import normalize_gnani_wav

ENV_PATH = Path(__file__).resolve().parent / ".env"
ENV_VALUES = dotenv_values(ENV_PATH)
# Always use the saved backend configuration rather than a stale parent-process value.
load_dotenv(ENV_PATH, override=True)
app = FastAPI(title="Language Friend voice API")
app.add_middleware(CORSMiddleware, allow_origins=[os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")], allow_methods=["*"], allow_headers=["*"])
SUPPORTED_LANGUAGE_CODES = {"en-IN", "te-IN", "kn-IN", "hi-IN", "ta-IN"}
SUPPORTED_STYLES = {"Telugu", "Tenglish", "Hindi", "Hinglish", "Kannada", "Kanglish", "Tamil", "Tanglish", "English"}
GEMINI_TIMEOUT = httpx.Timeout(45.0)
BOT_REPLY_TIMEOUT = httpx.Timeout(45.0)
BOT_REPLY_BUDGET_SECONDS = 45.0
BOT_GEMINI_FALLBACK_SLICE_SECONDS = 10.0
TRANSLATION_BUDGET_SECONDS = 45.0
GEMINI_FALLBACK_SLICE_SECONDS = 10.0
SARVAM_SINGLE_REQUEST_SECONDS = 32.0
SARVAM_ROMAN_REQUEST_SECONDS = 16.0
SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate"
SARVAM_TRANSLATION_MODEL = "mayura:v1"
SARVAM_CHAT_URL = "https://api.sarvam.ai/v2/chat/completions"
SARVAM_CHAT_MODEL = "glm5.3-flash"
ROMAN_STYLES = {"Tenglish", "Hinglish", "Kanglish", "Tanglish"}
STYLE_LANGUAGE_CODES = {"Telugu": "te-IN", "Tenglish": "te-IN", "Hindi": "hi-IN", "Hinglish": "hi-IN", "Kannada": "kn-IN", "Kanglish": "kn-IN", "Tamil": "ta-IN", "Tanglish": "ta-IN", "English": "en-IN"}
LANGUAGE_NAMES = {"en-IN": "English", "te-IN": "Telugu", "kn-IN": "Kannada", "hi-IN": "Hindi", "ta-IN": "Tamil"}
NATIVE_SCRIPT_RANGES = {"Tenglish": (0x0C00, 0x0C7F), "Hinglish": (0x0900, 0x097F), "Kanglish": (0x0C80, 0x0CFF), "Tanglish": (0x0B80, 0x0BFF)}

@dataclass(frozen=True)
class TranslationResult:
    display: str
    speech_text: str
    provider: str = "gemini"

def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise HTTPException(503, f"{name} is not configured on the backend.")
    return value

def validate_audio(data: bytes) -> None:
    try:
        with wave.open(BytesIO(data), "rb") as wav:
            valid = (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) == (1, 2, 16000, "NONE")
            duration = wav.getnframes() / 16000
            if not valid or not 0.25 <= duration <= 30: raise ValueError
    except (wave.Error, EOFError, ValueError):
        raise HTTPException(400, "Audio conversion failed: send mono, 16-bit PCM WAV at 16 kHz (0.25–30 seconds).") from None


def validate_wav_upload(audio: UploadFile) -> None:
    """Reject browser uploads that cannot be handled by Gnani before reading them."""
    content_type = (audio.content_type or "").split(";", 1)[0].lower()
    if content_type not in {"audio/wav", "audio/wave", "audio/x-wav", "application/octet-stream"}:
        raise HTTPException(415, "Unsupported audio format. Record a 16 kHz mono PCM WAV file and try again.")


async def gnani_stt(audio: UploadFile, language: str) -> str:
    key, url = required("GNANI_API_KEY"), required("GNANI_STT_URL")
    data = await audio.read(); validate_audio(data)
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(url, headers={"X-API-Key-ID": key}, files={"audio_file": ("recording.wav", BytesIO(data), "audio/wav")}, data={"model": "prisma-v3.0", "language_code": language, "format": "codemix"})
    except httpx.RequestError as error:
        raise HTTPException(502, f"Gnani transcription could not be reached: {type(error).__name__}. Check GNANI_STT_URL and its TLS certificate.") from None
    if response.is_error: raise HTTPException(502, f"Gnani transcription failed: {response.text[:240]}")
    body = response.json(); transcript = body.get("text") or body.get("transcript") or body.get("transcription")
    if not transcript: raise HTTPException(502, "Gnani returned no transcript.")
    return transcript

def gemini_failure(operation: str, status_code: int | None = None) -> HTTPException:
    if operation == "reply":
        if status_code == 429: return HTTPException(429, "AI reply service is quota-limited. Retry reply.")
        if status_code == 503: return HTTPException(503, "AI reply service is busy. Retry reply.")
        if status_code == 504: return HTTPException(504, "AI reply took too long. Retry reply.")
        return HTTPException(502, "AI reply service could not respond. Retry reply.")
    if status_code == 429: return HTTPException(429, "Translation service is quota-limited. Please retry.")
    if status_code == 503: return HTTPException(503, "Translation service busy. Try again.")
    if status_code == 504: return HTTPException(504, "Gemini took too long to respond. Please retry your translation.")
    return HTTPException(502, "Gemini request could not be completed. Please retry.")

async def gemini(contents: list[dict], system_instruction: str, *, operation: str = "translation", timeout: httpx.Timeout = GEMINI_TIMEOUT, max_output_tokens: int | None = None) -> str:
    key = required("GEMINI_API_KEY"); model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    generation_config = {"temperature": 0.35}
    if max_output_tokens: generation_config["maxOutputTokens"] = max_output_tokens
    payload = {"systemInstruction": {"parts": [{"text": system_instruction}]}, "contents": contents, "generationConfig": generation_config}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, params={"key": key}, json=payload)
    except httpx.ReadTimeout:
        raise gemini_failure(operation, 504) from None
    except httpx.RequestError as error:
        raise gemini_failure(operation) from error
    if response.status_code in {429, 503}: raise gemini_failure(operation, response.status_code)
    if response.is_error: raise gemini_failure(operation, response.status_code)
    try: return response.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError): raise HTTPException(502, "Gemini returned no usable text.") from None

def remaining_bot_reply_time(deadline: float, limit: float) -> float:
    remaining = min(limit, deadline - time.monotonic())
    if remaining <= 0: raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    return remaining

async def gemini_bot_reply(contents: list[dict], style: str, deadline: float) -> TranslationResult | None:
    """Return None only when the single configured Sarvam fallback should take over."""
    key = required("GEMINI_API_KEY"); model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    timeout = remaining_bot_reply_time(deadline, BOT_GEMINI_FALLBACK_SLICE_SECONDS)
    payload = {"systemInstruction": {"parts": [{"text": bot_instruction(style)}]}, "contents": contents, "generationConfig": {"temperature": 0.35, "maxOutputTokens": 512}}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            async with asyncio.timeout(timeout): response = await client.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", params={"key": key}, json=payload)
    except (TimeoutError, httpx.ReadTimeout):
        return None
    except httpx.RequestError as error:
        raise gemini_failure("reply") from error
    if response.status_code in {429, 503}: return None
    if response.is_error: raise gemini_failure("reply", response.status_code)
    try: return bot_reply_result(response_text(response), style, provider="gemini")
    except HTTPException: return None

def translation_instruction(target_style: str, roman_output: bool) -> str:
    base = f"Translate the message faithfully for a live two-person conversation. Preserve the speaker's intent, quantities, prices, and whether an action is stated. A desire, need, request, or availability statement is not a purchase action. Do not infer a transaction from an item, packet, shop context, or price; use buy or purchase wording only when the source explicitly states that action. Preserve the speaker's level of respect and number in forms of address. Respect may be carried by the verb ending even when a pronoun is omitted: do not turn familiar singular speech into respectful or plural speech, or vice versa. Use natural target-language pronouns and matching verb forms. Use everyday wording and keep natural loanwords where appropriate. {style_instruction(target_style)}"
    if not roman_output:
        return f"{base} Return only the translated message, with no notes or quotation marks."
    native = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[target_style]
    return f'{base} Return a JSON object with exactly two string fields: "display" must be the requested Romanized output, and "speech_text" must be the same translation in native {native} script for speech synthesis. Return no other text.'

def response_text(response: httpx.Response) -> str:
    try: return response.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError, ValueError): raise HTTPException(502, "Gemini returned no usable text.") from None

def translation_result(text: str, roman_output: bool, provider: str = "gemini") -> TranslationResult:
    if not roman_output:
        return TranslationResult(display=text, speech_text=text, provider=provider)
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"): text = text[:-3]
    try:
        body = json.loads(text); display = body["display"].strip(); speech_text = body["speech_text"].strip()
    except (json.JSONDecodeError, KeyError, AttributeError, TypeError): raise HTTPException(502, "Gemini returned an unusable translation format.") from None
    if not display or not speech_text: raise HTTPException(502, "Gemini returned an unusable translation format.")
    return TranslationResult(display=display, speech_text=speech_text, provider=provider)

def contains_native_script(text: str, style: str) -> bool:
    lower, upper = NATIVE_SCRIPT_RANGES[style]
    return any(lower <= ord(character) <= upper for character in text)

def contains_latin(text: str) -> bool:
    return any("A" <= character <= "Z" or "a" <= character <= "z" for character in text)

def bot_reply_result(text: str, style: str, provider: str) -> TranslationResult:
    result = translation_result(text, style in ROMAN_STYLES, provider=provider)
    if style not in ROMAN_STYLES: return result
    display, speech_text = result.display, result.speech_text
    # Correct only the unambiguous reversed-field provider response. Otherwise
    # reject it rather than showing native script under a Roman-language setting.
    if contains_native_script(display, style) and contains_latin(speech_text) and not contains_native_script(speech_text, style):
        display, speech_text = speech_text, display
    if not contains_latin(display) or contains_native_script(display, style) or not contains_native_script(speech_text, style):
        raise HTTPException(502, "AI reply provider returned the wrong script format.")
    return TranslationResult(display=display, speech_text=speech_text, provider=provider)

def gemini_translation_result(response: httpx.Response, roman_output: bool) -> TranslationResult:
    return translation_result(response_text(response), roman_output)

def remaining_translation_time(deadline: float, limit: float) -> float:
    remaining = min(limit, deadline - time.monotonic())
    if remaining <= 0: raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.")
    return remaining

async def gemini_translation(message: str, target_style: str, deadline: float) -> TranslationResult | None:
    """Return None only when a configured Sarvam fallback should take over."""
    key = required("GEMINI_API_KEY"); model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash"); roman_output = target_style in ROMAN_STYLES
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {"systemInstruction": {"parts": [{"text": translation_instruction(target_style, roman_output)}]}, "contents": [{"role": "user", "parts": [{"text": message}]}], "generationConfig": {"temperature": 0.35}}
    timeout = remaining_translation_time(deadline, GEMINI_FALLBACK_SLICE_SECONDS)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            async with asyncio.timeout(timeout): response = await client.post(url, params={"key": key}, json=payload)
    except (TimeoutError, httpx.ReadTimeout):
        return None
    except httpx.RequestError as error:
        raise HTTPException(502, f"Gemini request could not be completed: {type(error).__name__}. Please retry.") from None
    if response.status_code in {429, 503}: return None
    if response.is_error: raise HTTPException(502, f"Gemini request failed: {response.text[:240]}")
    return gemini_translation_result(response, roman_output)

def sarvam_payload(message: str, source_language: str, target_language: str, target_style: str, output_script: str | None) -> dict:
    payload = {"input": message, "source_language_code": source_language, "target_language_code": target_language, "model": SARVAM_TRANSLATION_MODEL, "mode": "code-mixed" if target_style in ROMAN_STYLES else "modern-colloquial"}
    if output_script: payload["output_script"] = output_script
    return payload

async def sarvam_text(payload: dict, deadline: float, limit: float) -> str:
    key = required("SARVAM_API_KEY"); timeout = remaining_translation_time(deadline, limit)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            async with asyncio.timeout(timeout): response = await client.post(os.getenv("SARVAM_TRANSLATE_URL", SARVAM_TRANSLATE_URL), headers={"api-subscription-key": key}, json=payload)
    except (TimeoutError, httpx.RequestError):
        raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.") from None
    if response.is_error: raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.")
    try: translated = response.json()["translated_text"].strip()
    except (KeyError, TypeError, ValueError): raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.") from None
    if not translated: raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.")
    return translated

def sarvam_chat_instruction(source_language: str, target_style: str, roman_output: bool) -> str:
    source = LANGUAGE_NAMES[source_language]
    target = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}.get(target_style, target_style)
    base = f"Translate only the user's message from {source} to {target} for a live two-person conversation. Do not answer the message. Preserve its meaning, quantities, prices, actions, second-person number, and level of respect exactly. Familiar and respectful address are different meanings. The source may encode this only in a verb ending; retain the matching target-language verb ending and do not make it more formal. {style_instruction(target_style)}"
    if not roman_output: return f"{base} Return only the translation, with no explanation or quotation marks."
    native = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[target_style]
    return f'{base} Return exactly one valid JSON object and nothing else: {{"display":"the Romanized {target} translation","speech_text":"the identical translation in native {native} script"}}.'

async def sarvam_chat_translation(message: str, source_language: str, target_style: str, deadline: float) -> TranslationResult:
    """Instruction-following translation fallback; never used for AI Bot replies."""
    key = required("SARVAM_API_KEY"); roman_output = target_style in ROMAN_STYLES
    timeout = remaining_translation_time(deadline, SARVAM_SINGLE_REQUEST_SECONDS)
    payload = {
        "model": os.getenv("SARVAM_CHAT_MODEL", SARVAM_CHAT_MODEL),
        "messages": [
            {"role": "system", "content": sarvam_chat_instruction(source_language, target_style, roman_output)},
            {"role": "user", "content": message},
        ],
        "max_tokens": 192,
        "temperature": 0.2,
        "reasoning_effort": "low",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            async with asyncio.timeout(timeout): response = await client.post(os.getenv("SARVAM_CHAT_URL", SARVAM_CHAT_URL), headers={"api-subscription-key": key}, json=payload)
    except (TimeoutError, httpx.RequestError):
        raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.") from None
    if response.is_error: raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.")
    try: translated = response.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, ValueError): raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.") from None
    if not translated: raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.")
    return translation_result(translated, roman_output, provider="sarvam-chat")

async def sarvam_bot_reply(messages: list[dict], style: str, deadline: float) -> TranslationResult:
    """One bounded conversational fallback for AI Bot; never a translation request."""
    key = required("SARVAM_API_KEY")
    timeout = remaining_bot_reply_time(deadline, SARVAM_SINGLE_REQUEST_SECONDS)
    payload = {
        "model": os.getenv("SARVAM_CHAT_MODEL", SARVAM_CHAT_MODEL),
        "messages": [{"role": "system", "content": bot_instruction(style)}, *messages],
        "max_tokens": 512,
        "temperature": 0.2,
        "reasoning_effort": "low",
    }
    if style in ROMAN_STYLES:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "bot_reply",
                "schema": {
                    "type": "object",
                    "properties": {"display": {"type": "string"}, "speech_text": {"type": "string"}},
                    "required": ["display", "speech_text"],
                    "additionalProperties": False,
                },
            },
        }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            async with asyncio.timeout(timeout): response = await client.post(os.getenv("SARVAM_CHAT_URL", SARVAM_CHAT_URL), headers={"api-subscription-key": key}, json=payload)
    except (TimeoutError, httpx.RequestError):
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.") from None
    if response.is_error: raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    try: reply_text = response.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, ValueError): raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.") from None
    if not reply_text: raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    try: return bot_reply_result(reply_text, style, provider="sarvam-chat")
    except HTTPException: raise HTTPException(503, "AI reply services returned an unusable reply. Retry reply.") from None

async def translate_conversation(message: str, source_language: str, source_style: str, target_language: str, target_style: str) -> TranslationResult:
    roman_output = target_style in ROMAN_STYLES
    if not os.getenv("SARVAM_API_KEY"):
        translated = await gemini([{"role": "user", "parts": [{"text": message}]}], translation_instruction(target_style, roman_output))
        return translation_result(translated, roman_output)
    deadline = time.monotonic() + TRANSLATION_BUDGET_SECONDS
    primary = await gemini_translation(message, target_style, deadline)
    if primary: return primary
    return await sarvam_chat_translation(message, source_language, target_style, deadline)

def style_instruction(style: str) -> str:
    if style in {"Tenglish", "Hinglish", "Kanglish", "Tanglish"}:
        base = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[style]
        return f"Write natural conversational {style}: write the {base} words in the Latin alphabet, using English only for familiar natural loanwords. Do not turn the response into English."
    if style == "English": return "Write in clear, natural English using the Latin alphabet."
    return f"Write natural {style} using its native script. Do not transliterate it into Latin letters."

def bot_instruction(style: str) -> str:
    base = f"You are Language Friend, a warm conversational assistant. Answer naturally and directly in one or two concise sentences using everyday wording. {style_instruction(style)}"
    if style not in ROMAN_STYLES:
        return f"{base} Return only the response."
    native = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[style]
    return f'{base} Return a JSON object with exactly two string fields: "display" must be the requested Romanized reply, and "speech_text" must be the same reply in native {native} script for speech synthesis. Return no other text.'

def validate_language(language: str, style: str) -> None:
    if language not in SUPPORTED_LANGUAGE_CODES or style not in SUPPORTED_STYLES:
        raise HTTPException(422, "Unsupported language or writing style.")

@app.get("/api/health")
async def health():
    required_names = ("GNANI_API_KEY", "GNANI_STT_URL", "GNANI_TTS_URL", "GEMINI_API_KEY")
    provider_names = (*required_names, "SARVAM_API_KEY")
    return {"ok": True, "configured": all(os.getenv(name) for name in required_names), "providers": {name: bool(os.getenv(name)) for name in provider_names}, "environment": {"gemini_key_matches_backend_env": bool(ENV_VALUES.get("GEMINI_API_KEY")) and os.getenv("GEMINI_API_KEY") == ENV_VALUES.get("GEMINI_API_KEY")}}

@app.post("/api/conversations/turn")
async def turn(audio: UploadFile = File(...), speaker: str = Form(...), source_language: str = Form(...), source_style: str = Form(...), target_language: str = Form(...), target_style: str = Form(...)):
    validate_language(source_language, source_style); validate_language(target_language, target_style)
    validate_wav_upload(audio)
    transcript = await gnani_stt(audio, source_language)
    translation = await translate_conversation(transcript, source_language, source_style, target_language, target_style)
    return {"speaker": speaker, "transcript": transcript, "translation": translation.display, "speech_text": translation.speech_text, "provider": translation.provider, "source_language": source_language, "target_language": target_language}

@app.post("/api/conversations/text")
async def text_turn(message: str = Form(...), source_language: str = Form(...), source_style: str = Form(...), target_language: str = Form(...), target_style: str = Form(...)):
    validate_language(source_language, source_style); validate_language(target_language, target_style)
    if not message.strip(): raise HTTPException(422, "Message cannot be empty.")
    translation = await translate_conversation(message.strip(), source_language, source_style, target_language, target_style)
    return {"translation": translation.display, "speech_text": translation.speech_text, "provider": translation.provider, "target_language": target_language, "target_style": target_style}

@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form(...)):
    if language not in SUPPORTED_LANGUAGE_CODES: raise HTTPException(422, "Unsupported spoken language.")
    validate_wav_upload(audio)
    return {"transcript": await gnani_stt(audio, language), "language": language}

@app.post("/api/bot/reply")
async def bot_reply(message: str = Form(...), style: str = Form(...), history: str = Form("[]")):
    if style not in SUPPORTED_STYLES: raise HTTPException(422, "Unsupported chat language.")
    if not message.strip(): raise HTTPException(422, "Message cannot be empty.")
    try: parsed = json.loads(history)
    except json.JSONDecodeError: raise HTTPException(422, "Conversation history is invalid.") from None
    if not isinstance(parsed, list): raise HTTPException(422, "Conversation history is invalid.")
    contents = []; sarvam_messages = []
    for item in parsed[-12:]:
        if not isinstance(item, dict) or item.get("role") not in {"user", "bot"} or not isinstance(item.get("text"), str): continue
        text = item["text"][:4000]
        contents.append({"role": "model" if item["role"] == "bot" else "user", "parts": [{"text": text}]})
        sarvam_messages.append({"role": "assistant" if item["role"] == "bot" else "user", "content": text})
    current_message = message.strip()[:4000]
    contents.append({"role": "user", "parts": [{"text": current_message}]})
    sarvam_messages.append({"role": "user", "content": current_message})
    if not os.getenv("SARVAM_API_KEY"):
        reply = bot_reply_result(await gemini(contents, bot_instruction(style), operation="reply", timeout=BOT_REPLY_TIMEOUT, max_output_tokens=512), style, provider="gemini")
    else:
        deadline = time.monotonic() + BOT_REPLY_BUDGET_SECONDS
        primary = await gemini_bot_reply(contents, style, deadline)
        reply = primary if primary else await sarvam_bot_reply(sarvam_messages, style, deadline)
    return {"reply": reply.display, "speech_text": reply.speech_text, "speech_language": STYLE_LANGUAGE_CODES[style], "style": style, "provider": reply.provider}

@app.post("/api/speech")
async def speech(text: str = Form(...), language: str = Form(...)):
    if language not in SUPPORTED_LANGUAGE_CODES: raise HTTPException(422, "Unsupported speech language.")
    if not text.strip(): raise HTTPException(422, "Text is required for speech synthesis.")
    key, url = required("GNANI_API_KEY"), required("GNANI_TTS_URL")
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(url, headers={"X-API-Key-ID": key, "Accept": "audio/wav"}, json={"text": text, "model": "timbre-v2.5", "voice": "Lavanya", "language": language, "speed": 1.0, "audio_config": {"sample_rate": 24000, "num_channels": 1, "sample_width": 2, "encoding": "linear_pcm", "container": "wav"}})
    except httpx.RequestError as error:
        raise HTTPException(502, f"Gnani speech synthesis could not be reached: {type(error).__name__}. Check GNANI_TTS_URL and its TLS certificate.") from None
    if response.is_error: raise HTTPException(502, f"Gnani speech synthesis failed: {response.text[:240]}")
    try: wav = normalize_gnani_wav(response.content)
    except ValueError as error: raise HTTPException(502, f"Gnani returned unusable speech audio: {error}") from None
    return Response(content=wav, media_type="audio/wav")
