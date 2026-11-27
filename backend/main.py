"""Language Friend voice API. Provider keys remain on the backend."""
import asyncio
import json
import logging
import os
import re
import time
import wave
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from audio import normalize_gnani_wav
from amounts import AMOUNT_INSTRUCTION, protect_amounts

ENV_PATH = Path(__file__).resolve().parent / ".env"
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
SARVAM_ROMAN_RECOVERY_SECONDS = 12.0
SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate"
SARVAM_TRANSLITERATE_URL = "https://api.sarvam.ai/transliterate"
SARVAM_TRANSLATION_MODEL = "mayura:v1"
SARVAM_CHAT_URL = "https://api.sarvam.ai/v2/chat/completions"
SARVAM_CHAT_MODEL = "glm5.3-flash"
SARVAM_BOT_MAX_TOKENS = 768
ROMAN_STYLES = {"Tenglish", "Hinglish", "Kanglish", "Tanglish"}
STYLE_LANGUAGE_CODES = {"Telugu": "te-IN", "Tenglish": "te-IN", "Hindi": "hi-IN", "Hinglish": "hi-IN", "Kannada": "kn-IN", "Kanglish": "kn-IN", "Tamil": "ta-IN", "Tanglish": "ta-IN", "English": "en-IN"}
LANGUAGE_NAMES = {"en-IN": "English", "te-IN": "Telugu", "kn-IN": "Kannada", "hi-IN": "Hindi", "ta-IN": "Tamil"}
NATIVE_SCRIPT_RANGES = {"Tenglish": (0x0C00, 0x0C7F), "Hinglish": (0x0900, 0x097F), "Kanglish": (0x0C80, 0x0CFF), "Tanglish": (0x0B80, 0x0BFF)}
READING_SCRIPTS = {"Latin": "en-IN", **{name: language for language, name in LANGUAGE_NAMES.items() if language != "en-IN"}}
ROMAN_STYLE_BY_LANGUAGE = {STYLE_LANGUAGE_CODES[style]: style for style in ROMAN_STYLES}
HINDI_REGISTER = " For Hindi address, use तुम/तुम्हारा for ordinary familiar singular speech and आप/आपका for respectful speech. Reserve तू for explicitly intimate or rude speech."
ROMAN_VOWELS = " Use readable spellings. For a name without a supplied Latin spelling, write long ee and oo sounds with doubled vowels, but use the conventional single final a in names ending in a (for example, Deepika, rather than Dipikaa). Keep a Latin spelling supplied by the speaker."
BOT_LOGGER = logging.getLogger("language_friend.bot_reply")

@dataclass(frozen=True)
class TranslationResult:
    display: str
    speech_text: str
    provider: str = "gemini"


@dataclass(frozen=True)
class BotReplyCandidate:
    display: str | None
    speech_text: str | None
    json_status: str


def bot_reply_diagnostic(provider: str, style: str, phase: str, **metadata: object) -> None:
    """Log only reply-processing metadata; never include prompts, replies, or keys."""
    event = {"provider": provider, "style": style, "phase": phase, **metadata}
    BOT_LOGGER.info("bot_reply_diagnostic %s", json.dumps(event, sort_keys=True, separators=(",", ":")))

def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise HTTPException(503, f"{name} is not configured on the backend.")
    return value


def configured(name: str) -> bool:
    """Treat an empty Compose environment value as not configured."""
    return bool(os.getenv(name))


def provider_configuration_error(feature: str) -> HTTPException:
    return HTTPException(
        503,
        f"{feature} is not configured on the backend. Set GEMINI_API_KEY or SARVAM_API_KEY and restart the backend.",
    )

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

def remaining_bot_reply_time(deadline: float, limit: float, reserve: float = 0.0) -> float:
    """Return a bounded provider timeout while preserving time for a Roman recovery."""
    remaining = min(limit, deadline - time.monotonic() - reserve)
    if remaining <= 0: raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    return remaining

def gemini_bot_response(response: httpx.Response) -> tuple[str, str | None]:
    try:
        candidate = response.json()["candidates"][0]
        return candidate["content"]["parts"][0]["text"].strip(), candidate.get("finishReason")
    except (AttributeError, KeyError, IndexError, TypeError, ValueError):
        raise HTTPException(502, "Gemini returned no usable text.") from None


async def gemini_bot_reply(contents: list[dict], style: str, deadline: float, max_wait_seconds: float = BOT_GEMINI_FALLBACK_SLICE_SECONDS) -> TranslationResult | None:
    """Return None only when the single configured Sarvam fallback should take over."""
    key = required("GEMINI_API_KEY"); model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    timeout = remaining_bot_reply_time(deadline, max_wait_seconds)
    payload = {"systemInstruction": {"parts": [{"text": bot_instruction(style)}]}, "contents": contents, "generationConfig": {"temperature": 0.35, "maxOutputTokens": 512}}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            async with asyncio.timeout(timeout): response = await client.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", params={"key": key}, json=payload)
    except (TimeoutError, httpx.ReadTimeout):
        bot_reply_diagnostic("gemini", style, "transport", outcome="timeout")
        return None
    except httpx.RequestError as error:
        bot_reply_diagnostic("gemini", style, "transport", outcome="request_error", error_type=type(error).__name__)
        raise gemini_failure("reply") from error
    if response.status_code in {429, 503}:
        bot_reply_diagnostic("gemini", style, "upstream", status_code=response.status_code, outcome="fallback")
        return None
    if response.is_error:
        bot_reply_diagnostic("gemini", style, "upstream", status_code=response.status_code, outcome="error")
        raise gemini_failure("reply", response.status_code)
    try:
        reply_text, finish_reason = gemini_bot_response(response)
    except HTTPException:
        bot_reply_diagnostic("gemini", style, "parse", json_status="response_shape_invalid", outcome="fallback")
        return None
    bot_reply_diagnostic("gemini", style, "upstream", status_code=response.status_code, finish_reason=finish_reason, content_length=len(reply_text))
    try:
        return await resolve_bot_reply(reply_text, style, provider="gemini", deadline=deadline, finish_reason=finish_reason, allow_recovery=False)
    except HTTPException:
        return None

def translation_instruction(target_style: str, roman_output: bool) -> str:
    base = f"Translate the message faithfully for a live two-person conversation. Preserve the speaker's intent, quantities, prices, and whether an action is stated. A desire, need, request, or availability statement is not a purchase action. Do not infer a transaction from an item, packet, shop context, or price; use buy or purchase wording only when the source explicitly states that action. Preserve the speaker's level of respect and number in forms of address. Respect may be carried by the verb ending even when a pronoun is omitted: do not turn familiar singular speech into respectful or plural speech, or vice versa. Use natural target-language pronouns and matching verb forms. Use everyday wording and keep natural loanwords where appropriate. {style_instruction(target_style)}"
    if STYLE_LANGUAGE_CODES.get(target_style) == "hi-IN":
        base += HINDI_REGISTER
    if not roman_output:
        return f"{base} Return only the translated message, with no notes or quotation marks."
    native = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[target_style]
    return f'{base} First write the idiomatic {native} translation in its native script for "speech_text". Then transliterate those exact words into Latin script for "display". Return only a JSON object with these two string fields. Use everyday target-language forms rather than copying similar-looking source words or pronouns.{ROMAN_VOWELS}'

def transliteration_instruction(source_style: str, target_style: str) -> str:
    base = (
        f"Convert only the script of the input from {source_style} to {target_style}. "
        "Keep the original words, names, register, numbers, and punctuation. "
        "Do not paraphrase, translate loanwords, add information, or answer the message. "
        + style_instruction(target_style)
    )
    if target_style in ROMAN_STYLES:
        return base + ' Return only a JSON object with "display" in Latin script and "speech_text" in the original native script.'
    return base + " Return only the result."

def response_text(response: httpx.Response) -> str:
    try: return response.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError, ValueError): raise HTTPException(502, "Gemini returned no usable text.") from None

def translation_result(text: str, roman_output: bool, provider: str = "gemini") -> TranslationResult:
    if not roman_output:
        return TranslationResult(display=text, speech_text=text, provider=provider)
    text = unfence_json(text)
    try:
        body = json.loads(text); display = body["display"].strip(); speech_text = body["speech_text"].strip()
    except (json.JSONDecodeError, KeyError, AttributeError, TypeError): raise HTTPException(502, "Gemini returned an unusable translation format.") from None
    if not display or not speech_text: raise HTTPException(502, "Gemini returned an unusable translation format.")
    return TranslationResult(display=display, speech_text=speech_text, provider=provider)


def unfence_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"): text = text[:-3]
    return text.strip()

def contains_native_script(text: str, style: str) -> bool:
    lower, upper = NATIVE_SCRIPT_RANGES[style]
    return any(lower <= ord(character) <= upper for character in text)

def contains_latin(text: str) -> bool:
    return any("A" <= character <= "Z" or "a" <= character <= "z" for character in text)


def contains_supported_native_script(text: str) -> bool:
    return any(contains_native_script(text, style) for style in ROMAN_STYLES)


def native_text_is_valid(text: str | None, style: str) -> bool:
    return bool(text and contains_native_script(text, style) and not any(contains_native_script(text, other_style) for other_style in ROMAN_STYLES if other_style != style))


def roman_text_is_valid(text: str | None) -> bool:
    return bool(text and contains_latin(text) and not contains_supported_native_script(text))


def bot_reply_candidate(text: str, style: str) -> BotReplyCandidate:
    """Extract a Roman pair without accepting it as valid or logging its contents."""
    body_text = unfence_json(text)
    try:
        body = json.loads(body_text)
    except json.JSONDecodeError:
        # A provider occasionally drops the JSON wrapper but still returns one
        # native-script answer. It is safe to use only after script validation.
        return BotReplyCandidate(None, body_text or None, "invalid_json_plain_text")
    if not isinstance(body, dict): return BotReplyCandidate(None, None, "json_not_object")
    display = body.get("display")
    speech_text = body.get("speech_text")
    return BotReplyCandidate(
        display.strip() if isinstance(display, str) else None,
        speech_text.strip() if isinstance(speech_text, str) else None,
        "json_object" if isinstance(display, str) and isinstance(speech_text, str) else "json_fields_invalid",
    )


def reply_script_metadata(candidate: BotReplyCandidate, style: str) -> dict[str, object]:
    display, speech_text = candidate.display, candidate.speech_text
    return {
        "json_status": candidate.json_status,
        "display_length": len(display or ""),
        "speech_length": len(speech_text or ""),
        "display_latin": contains_latin(display or ""),
        "display_native": contains_native_script(display or "", style),
        "speech_latin": contains_latin(speech_text or ""),
        "speech_native": contains_native_script(speech_text or "", style),
        "speech_other_native": bool(speech_text) and contains_supported_native_script(speech_text) and not contains_native_script(speech_text, style),
    }


def valid_roman_reply(candidate: BotReplyCandidate, style: str, provider: str) -> TranslationResult | None:
    if roman_text_is_valid(candidate.display) and native_text_is_valid(candidate.speech_text, style):
        return TranslationResult(display=candidate.display or "", speech_text=candidate.speech_text or "", provider=provider)
    return None


def recovery_source(candidate: BotReplyCandidate, style: str) -> tuple[str, str, str] | None:
    """Prefer the native reply so display and speech remain one coherent answer."""
    for text, origin in ((candidate.speech_text, "speech_text"), (candidate.display, "display")):
        if native_text_is_valid(text, style): return text or "", STYLE_LANGUAGE_CODES[style], origin
    for text, origin in ((candidate.display, "display"), (candidate.speech_text, "speech_text")):
        if roman_text_is_valid(text): return text or "", "en-IN", origin
    return None


def reply_was_truncated(finish_reason: str | None) -> bool:
    return (finish_reason or "").lower() in {"length", "max_tokens"}

def bot_reply_result(text: str, style: str, provider: str) -> TranslationResult:
    if style not in ROMAN_STYLES: return translation_result(text, False, provider=provider)
    result = valid_roman_reply(bot_reply_candidate(text, style), style, provider)
    if not result: raise HTTPException(502, "AI reply provider returned the wrong script format.")
    return result

def gemini_translation_result(response: httpx.Response, roman_output: bool) -> TranslationResult:
    return translation_result(response_text(response), roman_output)

def remaining_translation_time(deadline: float, limit: float) -> float:
    remaining = min(limit, deadline - time.monotonic())
    if remaining <= 0: raise HTTPException(503, "Translation services are temporarily unavailable. Please retry.")
    return remaining

async def gemini_translation(message: str, target_style: str, deadline: float, instruction: str | None = None) -> TranslationResult | None:
    """Return None only when a configured Sarvam fallback should take over."""
    key = required("GEMINI_API_KEY"); model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash"); roman_output = target_style in ROMAN_STYLES
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {"systemInstruction": {"parts": [{"text": instruction or translation_instruction(target_style, roman_output)}]}, "contents": [{"role": "user", "parts": [{"text": message}]}], "generationConfig": {"temperature": 0.35}}
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
    try: return gemini_translation_result(response, roman_output)
    except HTTPException: return None

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
    if STYLE_LANGUAGE_CODES.get(target_style) == "hi-IN":
        base += HINDI_REGISTER
    if not roman_output: return f"{base} Return only the translation, with no explanation or quotation marks."
    native = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[target_style]
    return f'{base} First write the idiomatic {native} translation in its native script, using everyday target-language forms rather than copying similar-looking source words or pronouns. Transliterate those exact words for display.{ROMAN_VOWELS} Return only a JSON object: {{"speech_text":"the translation in native {native} script","display":"those exact words in Latin script"}}.'

async def sarvam_chat_translation(message: str, source_language: str, target_style: str, deadline: float, instruction: str | None = None) -> TranslationResult:
    """Instruction-following translation fallback; never used for AI Bot replies."""
    key = required("SARVAM_API_KEY"); roman_output = target_style in ROMAN_STYLES
    timeout = remaining_translation_time(deadline, SARVAM_SINGLE_REQUEST_SECONDS)
    payload = {
        "model": os.getenv("SARVAM_CHAT_MODEL", SARVAM_CHAT_MODEL),
        "messages": [
            {"role": "system", "content": instruction or sarvam_chat_instruction(source_language, target_style, roman_output)},
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


async def sarvam_transliteration_response(text: str, source_language: str, target_language: str, timeout: float) -> httpx.Response:
    key = required("SARVAM_API_KEY")
    payload = {
        "input": text,
        "source_language_code": source_language,
        "target_language_code": target_language,
        "numerals_format": "international",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        async with asyncio.timeout(timeout):
            return await client.post(os.getenv("SARVAM_TRANSLITERATE_URL", SARVAM_TRANSLITERATE_URL), headers={"api-subscription-key": key}, json=payload)


async def sarvam_transliterate_bot_reply(text: str, source_language: str, target_language: str, style: str, deadline: float) -> str:
    """Use Sarvam's documented native<->English transliteration directions for a repaired Roman pair."""
    timeout = remaining_bot_reply_time(deadline, SARVAM_ROMAN_RECOVERY_SECONDS)
    try:
        response = await sarvam_transliteration_response(text, source_language, target_language, timeout)
    except (TimeoutError, httpx.RequestError) as error:
        bot_reply_diagnostic("sarvam-transliterate", style, "transport", outcome="error", error_type=type(error).__name__, direction=f"{source_language}->{target_language}")
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.") from None
    if response.is_error:
        bot_reply_diagnostic("sarvam-transliterate", style, "upstream", outcome="error", status_code=response.status_code, direction=f"{source_language}->{target_language}")
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    try: transliterated = response.json()["transliterated_text"].strip()
    except (AttributeError, KeyError, TypeError, ValueError):
        bot_reply_diagnostic("sarvam-transliterate", style, "parse", outcome="invalid_response", direction=f"{source_language}->{target_language}")
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.") from None
    if not transliterated:
        bot_reply_diagnostic("sarvam-transliterate", style, "parse", outcome="empty", direction=f"{source_language}->{target_language}")
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    bot_reply_diagnostic("sarvam-transliterate", style, "upstream", outcome="success", status_code=response.status_code, direction=f"{source_language}->{target_language}", content_length=len(transliterated))
    return transliterated


async def resolve_bot_reply(text: str, style: str, provider: str, deadline: float, finish_reason: str | None = None, allow_recovery: bool = True) -> TranslationResult:
    """Validate a provider reply and, for Roman styles, repair one canonical script safely."""
    if reply_was_truncated(finish_reason):
        bot_reply_diagnostic(provider, style, "validation", finish_reason=finish_reason, outcome="truncated")
        raise HTTPException(502, "AI reply provider returned an incomplete reply.")
    if style not in ROMAN_STYLES:
        result = bot_reply_result(text, style, provider)
        bot_reply_diagnostic(provider, style, "validation", finish_reason=finish_reason, outcome="accepted", reply_length=len(result.display))
        return result

    candidate = bot_reply_candidate(text, style)
    metadata = reply_script_metadata(candidate, style)
    direct = valid_roman_reply(candidate, style, provider)
    if direct:
        bot_reply_diagnostic(provider, style, "validation", finish_reason=finish_reason, outcome="accepted", **metadata)
        return direct

    bot_reply_diagnostic(provider, style, "validation", finish_reason=finish_reason, outcome="recovery_needed", **metadata)
    if not allow_recovery:
        bot_reply_diagnostic(provider, style, "recovery", outcome="deferred_to_fallback")
        raise HTTPException(502, "AI reply provider returned an unusable reply.")
    source = recovery_source(candidate, style)
    if not source:
        bot_reply_diagnostic(provider, style, "recovery", outcome="no_coherent_source")
        raise HTTPException(502, "AI reply provider returned an unusable reply.")
    if not os.getenv("SARVAM_API_KEY"):
        bot_reply_diagnostic(provider, style, "recovery", outcome="transliteration_unconfigured")
        raise HTTPException(502, "AI reply provider returned an unusable reply.")

    canonical, source_language, field = source
    target_language = "en-IN" if source_language != "en-IN" else STYLE_LANGUAGE_CODES[style]
    transliterated = await sarvam_transliterate_bot_reply(canonical, source_language, target_language, style, deadline)
    repaired = BotReplyCandidate(
        transliterated if source_language != "en-IN" else canonical,
        canonical if source_language != "en-IN" else transliterated,
        "transliterated_recovery",
    )
    result = valid_roman_reply(repaired, style, f"{provider}+sarvam-transliterate")
    if not result:
        bot_reply_diagnostic(provider, style, "recovery", outcome="script_validation_failed", field=field, direction=f"{source_language}->{target_language}", **reply_script_metadata(repaired, style))
        raise HTTPException(502, "AI reply provider returned an unusable reply.")
    bot_reply_diagnostic(provider, style, "recovery", outcome="accepted", field=field, direction=f"{source_language}->{target_language}", **reply_script_metadata(repaired, style))
    return result


async def sarvam_bot_reply(messages: list[dict], style: str, deadline: float) -> TranslationResult:
    """One bounded conversational fallback for AI Bot; never a translation request."""
    key = required("SARVAM_API_KEY")
    reserve = SARVAM_ROMAN_RECOVERY_SECONDS if style in ROMAN_STYLES else 0.0
    timeout = remaining_bot_reply_time(deadline, SARVAM_SINGLE_REQUEST_SECONDS, reserve=reserve)
    payload = {
        "model": os.getenv("SARVAM_CHAT_MODEL", SARVAM_CHAT_MODEL),
        "messages": [{"role": "system", "content": bot_instruction(style)}, *messages],
        "max_tokens": SARVAM_BOT_MAX_TOKENS,
        "temperature": 0.2,
        "reasoning_effort": "low",
    }
    if style in ROMAN_STYLES:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "bot_reply",
                "strict": True,
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
    except (TimeoutError, httpx.RequestError) as error:
        bot_reply_diagnostic("sarvam-chat", style, "transport", outcome="error", error_type=type(error).__name__)
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.") from None
    if response.is_error:
        bot_reply_diagnostic("sarvam-chat", style, "upstream", outcome="error", status_code=response.status_code)
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    try:
        choice = response.json()["choices"][0]
        reply_text = choice["message"]["content"].strip()
        finish_reason = choice.get("finish_reason")
    except (AttributeError, KeyError, IndexError, TypeError, ValueError):
        bot_reply_diagnostic("sarvam-chat", style, "parse", outcome="response_shape_invalid")
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.") from None
    if not reply_text:
        bot_reply_diagnostic("sarvam-chat", style, "parse", outcome="empty", finish_reason=finish_reason)
        raise HTTPException(503, "AI reply services are temporarily unavailable. Retry reply.")
    bot_reply_diagnostic("sarvam-chat", style, "upstream", outcome="success", status_code=response.status_code, finish_reason=finish_reason, content_length=len(reply_text))
    try: return await resolve_bot_reply(reply_text, style, provider="sarvam-chat", deadline=deadline, finish_reason=finish_reason)
    except HTTPException: raise HTTPException(503, "AI reply services returned an unusable reply. Retry reply.") from None

async def translate_conversation(message: str, source_language: str, source_style: str, target_language: str, target_style: str) -> TranslationResult:
    roman_output = target_style in ROMAN_STYLES
    same_language = source_language == target_language
    preserve_display = same_language and roman_output and source_style == target_style
    instruction = transliteration_instruction(source_style, LANGUAGE_NAMES[target_language] if preserve_display else target_style) if same_language else None
    provider_style = LANGUAGE_NAMES[target_language] if preserve_display else target_style
    amounts = protect_amounts(message, source_language)
    gemini_instruction = instruction
    fallback_instruction = instruction
    if amounts.replacements:
        gemini_instruction = (instruction or translation_instruction(target_style, roman_output)) + AMOUNT_INSTRUCTION
        fallback_instruction = (instruction or sarvam_chat_instruction(source_language, target_style, roman_output)) + AMOUNT_INSTRUCTION
    preserve_speech = roman_output and same_language and source_style not in ROMAN_STYLES and native_text_is_valid(message, target_style)
    if amounts.replacements and not amounts.contains_words:
        number = amounts.restore(amounts.text)
        if number is not None:
            return TranslationResult(number, message if preserve_speech else number, provider="local")

    def finish(result: TranslationResult) -> TranslationResult | None:
        display = message if preserve_display else amounts.restore(result.display)
        speech = message if preserve_speech else amounts.restore(result.speech_text)
        if display is None or speech is None:
            return None
        return TranslationResult(display, speech, result.provider)

    def usable(result: TranslationResult) -> bool:
        # Numbers and punctuation also work as utterances. Otherwise reject a
        # provider result written in the wrong script for either output.
        if not any(character.isalpha() for character in message):
            return bool(result.display.strip() and result.speech_text.strip())
        native_style = next((style for style in ROMAN_STYLES if STYLE_LANGUAGE_CODES[style] == target_language), None)
        if native_style:
            return native_text_is_valid(result.speech_text, native_style) and (
                roman_text_is_valid(result.display) if roman_output else native_text_is_valid(result.display, native_style)
            )
        return roman_text_is_valid(result.display) and roman_text_is_valid(result.speech_text)

    has_gemini = configured("GEMINI_API_KEY")
    has_sarvam = configured("SARVAM_API_KEY")
    if not has_gemini and not has_sarvam:
        raise provider_configuration_error("Translation")

    if has_gemini and not has_sarvam:
        translated = await gemini(
            [{"role": "user", "parts": [{"text": amounts.text}]}],
            gemini_instruction or translation_instruction(target_style, roman_output),
        )
        result = finish(translation_result(translated, provider_style in ROMAN_STYLES))
        if result and usable(result): return result
        raise HTTPException(502, "Translation could not preserve the original amounts or writing script. Please retry.")

    deadline = time.monotonic() + TRANSLATION_BUDGET_SECONDS
    if has_gemini:
        primary = await gemini_translation(amounts.text, provider_style, deadline, gemini_instruction)
        if primary:
            result = finish(primary)
            if result and usable(result): return result
    result = finish(await sarvam_chat_translation(amounts.text, source_language, provider_style, deadline, fallback_instruction))
    if result and usable(result): return result
    raise HTTPException(502, "Translation could not preserve the original amounts or writing script. Please retry.")


async def render_pronunciation(message: str, language: str, script: str) -> str:
    """Write the already-translated words in a different script, keeping their language."""
    script_language = READING_SCRIPTS[script]
    if language == script_language or not any(character.isalpha() for character in message):
        return message
    amounts = protect_amounts(message, language)
    if not amounts.contains_words:
        return amounts.restore(amounts.text) or message
    deadline = time.monotonic() + TRANSLATION_BUDGET_SECONDS
    has_gemini = configured("GEMINI_API_KEY")
    has_sarvam = configured("SARVAM_API_KEY")

    def in_requested_script(text: str | None) -> bool:
        if script == "Latin":
            return roman_text_is_valid(text)
        return native_text_is_valid(text, ROMAN_STYLE_BY_LANGUAGE[script_language]) and not contains_latin(text or "")

    def accepted(text: str) -> str | None:
        # Script conversion keeps the canonical wording. Reject obvious additions,
        # omissions or changes to question/exclamation marks before using a provider.
        def word_count(value: str) -> int:
            return sum(any(char.isalnum() for char in part) for part in value.split())

        display = amounts.restore(text)
        if display and in_requested_script(display) and word_count(text) == word_count(amounts.text) and re.findall(r"[?!]", text) == re.findall(r"[?!]", amounts.text):
            return formatted(display)
        return None

    def formatted(text: str) -> str:
        if script != "Telugu":
            return text
        # Unlike a blended onset, two different stops usually span a syllable
        # boundary. Unjoin the first stop so it remains readable as a coda.
        return re.sub(r"([కఖగఘచఛజఝటఠడఢతథదధపఫబభ])్[\u200b\u200c\u200d]?(?=(?!\1)[కఖగఘచఛజఝటఠడఢతథదధపఫబభ])", r"\1్‌", text)

    # The dedicated API documents Latin-to-Indic and Indic-to-Latin.
    # Keep amounts protected with markers on the instruction-following path.
    if has_sarvam and "en-IN" in (language, script_language) and len(message) <= 1000 and not amounts.replacements:
        try:
            response = await sarvam_transliteration_response(message, language, script_language, remaining_translation_time(deadline, 7.0))
            if response.is_success:
                display = accepted(response.json()["transliterated_text"].strip())
                if display:
                    return display
        except (TimeoutError, httpx.RequestError, KeyError, AttributeError, TypeError, ValueError):
            pass

    instruction = (
        f"The input is already in {LANGUAGE_NAMES[language]}. This is a pronunciation guide, not a translation. "
        f"Write those same spoken words using only {script} letters. Keep the words and their order, names, register, "
        "pacing, and punctuation. Do not translate, paraphrase, answer, or change the level of respect. "
        "Use natural spoken pronunciation, including vowel length and consonants at the ends of syllables. "
        "For Telugu script use a virama with a zero-width non-joiner to show a syllable-final consonant "
        "before a new syllable; retain normal conjuncts within a syllable. Return only the pronunciation guide."
    )
    if amounts.replacements:
        instruction += AMOUNT_INSTRUCTION
    style = LANGUAGE_NAMES[script_language]  # Both providers must return plain text, even for Latin letters.
    if has_sarvam:
        primary = None
        if has_gemini:
            primary = await gemini_translation(amounts.text, style, deadline, instruction)
        if primary:
            display = accepted(primary.display)
            if display:
                return display
        fallback = await sarvam_chat_translation(amounts.text, language, style, deadline, instruction)
        output = fallback.display
    elif has_gemini:
        output = await gemini(
            [{"role": "user", "parts": [{"text": amounts.text}]}], instruction,
            timeout=httpx.Timeout(remaining_translation_time(deadline, TRANSLATION_BUDGET_SECONDS)),
        )
    else:
        raise provider_configuration_error("Pronunciation")
    display = accepted(output)
    if display:
        return display
    raise HTTPException(502, "Pronunciation could not preserve the requested script or amounts. Please retry.")

def style_instruction(style: str) -> str:
    if style in {"Tenglish", "Hinglish", "Kanglish", "Tanglish"}:
        base = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[style]
        return f"Write natural conversational {style}: write the {base} words in the Latin alphabet, using English only for familiar natural loanwords. Do not turn the response into English."
    if style == "English": return "Write in clear, natural English using the Latin alphabet."
    return f"Write natural {style} using its native script. Do not transliterate it into Latin letters."

def bot_instruction(style: str) -> str:
    base = (
        "You are Language Friend, a warm conversational assistant. Answer naturally and directly in one or two concise sentences. "
        "Address the user in a friendly, neutral way using ordinary polite wording. Do not address the user with unsolicited "
        "familial, gendered, or familiar titles such as akka, anna, bro, sister, bhai, or equivalents in any language. "
        "Use an address term only if the user explicitly asks you to call them that. Preserve such terms when they are part "
        "of text the user asks you to translate or quote. When repeating a shopping list, preserve the exact items, quantities, "
        "units, prices, and requested updates from the current message and conversation. Use the target language's ordinary "
        "words for familiar foods and household items even if the list was provided in English. Leave brand names and "
        "text requested verbatim as written. "
        + style_instruction(style)
    )
    if style not in ROMAN_STYLES:
        return f"{base} Return only the response."
    native = {"Tenglish": "Telugu", "Hinglish": "Hindi", "Kanglish": "Kannada", "Tanglish": "Tamil"}[style]
    return f'{base} Return a JSON object with exactly two string fields: "display" must be the requested Romanized reply, and "speech_text" must be the same reply in native {native} script for speech synthesis. Return no other text.'

def validate_language(language: str, style: str) -> None:
    if language not in SUPPORTED_LANGUAGE_CODES or style not in SUPPORTED_STYLES:
        raise HTTPException(422, "Unsupported language or writing style.")

@app.get("/api/health")
async def health():
    provider_names = ("GNANI_API_KEY", "GNANI_STT_URL", "GNANI_TTS_URL", "GEMINI_API_KEY", "SARVAM_API_KEY")
    transcription = configured("GNANI_API_KEY") and configured("GNANI_STT_URL")
    speech = configured("GNANI_API_KEY") and configured("GNANI_TTS_URL")
    language_provider = configured("GEMINI_API_KEY") or configured("SARVAM_API_KEY")
    return {
        "ok": True,
        "configured": transcription and speech and language_provider,
        "providers": {name: configured(name) for name in provider_names},
        "capabilities": {
            "transcription": transcription,
            "translation": language_provider,
            "pronunciation": language_provider,
            "bot_reply": language_provider,
            "speech": speech,
        },
    }

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

@app.post("/api/conversations/pronunciation")
async def pronunciation_turn(message: str = Form(...), language: str = Form(...), script: str = Form(...)):
    if language not in SUPPORTED_LANGUAGE_CODES or script not in READING_SCRIPTS:
        raise HTTPException(422, "Unsupported pronunciation language or script.")
    if not message.strip():
        raise HTTPException(422, "Message cannot be empty.")
    return {"pronunciation": await render_pronunciation(message.strip(), language, script)}

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
    contents = []; sarvam_messages = []; accepted_history = 0
    for item in parsed[-12:]:
        if not isinstance(item, dict) or item.get("role") not in {"user", "bot"} or not isinstance(item.get("text"), str): continue
        text = item["text"][:4000]
        contents.append({"role": "model" if item["role"] == "bot" else "user", "parts": [{"text": text}]})
        sarvam_messages.append({"role": "assistant" if item["role"] == "bot" else "user", "content": text})
        accepted_history += 1
    current_message = message.strip()[:4000]
    contents.append({"role": "user", "parts": [{"text": current_message}]})
    sarvam_messages.append({"role": "user", "content": current_message})
    bot_reply_diagnostic("route", style, "request", history_entries=len(parsed), accepted_history_entries=accepted_history, message_length=len(current_message))
    deadline = time.monotonic() + BOT_REPLY_BUDGET_SECONDS
    has_gemini = configured("GEMINI_API_KEY")
    has_sarvam = configured("SARVAM_API_KEY")
    if not has_gemini and not has_sarvam:
        raise provider_configuration_error("AI Bot")
    if has_gemini and not has_sarvam:
        reply = await resolve_bot_reply(await gemini(contents, bot_instruction(style), operation="reply", timeout=BOT_REPLY_TIMEOUT, max_output_tokens=512), style, provider="gemini", deadline=deadline)
    else:
        primary = await gemini_bot_reply(contents, style, deadline) if has_gemini else None
        reply = primary if primary else await sarvam_bot_reply(sarvam_messages, style, deadline)
    bot_reply_diagnostic(reply.provider, style, "response", outcome="success", reply_length=len(reply.display), speech_length=len(reply.speech_text), speech_language=STYLE_LANGUAGE_CODES[style])
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
