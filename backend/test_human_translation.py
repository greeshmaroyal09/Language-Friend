"""Human Chat preserves text through same-language script conversion."""
import json
import os
import unittest
from unittest.mock import ANY, AsyncMock, patch

import main
from amounts import protect_amounts


class AmountTests(unittest.TestCase):
    def test_recognizes_written_numbers_and_digits_in_supported_languages(self):
        examples = [
            ("te-IN", "ముప్పై ఐదు రూపాయలు; ముప్పైఐదు రూపాయలు; రెండు కిలోలు; ౧౨.౫ లీటర్లు", ["35", "35", "2", "12.5"]),
            ("te-IN", "muppai-ayidu rupayalu", ["35"]),
            ("kn-IN", "ಮೂವತ್ತೈದು ರೂಪಾಯಿ; ಮೂರು ಪ್ಯಾಕೆಟ್", ["35", "3"]),
            ("ta-IN", "முப்பத்தைந்து ரூபாய்; நான்கு கிலோ", ["35", "4"]),
            ("hi-IN", "पैंतीस रुपये; चार किलो; १,२५,०००.५० रुपये", ["35", "4", "1,25,000.50"]),
            ("en-IN", "Two hundred and thirty-five rupees; 2/3 cup; 4-5 packets", ["235", "2/3", "4", "5"]),
        ]
        for language, source, expected in examples:
            with self.subTest(language=language, source=source):
                self.assertEqual(list(protect_amounts(source, language).replacements.values()), expected)

    def test_rejects_missing_duplicate_or_extra_numbers(self):
        protected = protect_amounts("35 rupees for five packets", "en-IN")
        self.assertEqual(protected.restore(protected.text), "35 rupees for 5 packets")
        self.assertIsNone(protected.restore("30 rupees for [LFQAB] packets"))
        self.assertIsNone(protected.restore("[LFQAA] rupees and [LFQAA] per [LFQAB] packets"))
        self.assertIsNone(protected.restore(protected.text + " plus 10"))

    def test_hindi_give_is_not_mistaken_for_two(self):
        source = "मुझे दो किलो दूध दो।"
        protected = protect_amounts(source, "hi-IN")
        self.assertEqual(protected.restore(protected.text), "मुझे 2 किलो दूध दो।")


class HumanTranslationTests(unittest.IsolatedAsyncioTestCase):
    async def test_standalone_written_number_needs_no_provider(self):
        result = await main.translate_conversation("ముప్పై ఐదు", "te-IN", "Telugu", "te-IN", "Tenglish")
        self.assertEqual((result.display, result.speech_text, result.provider), ("35", "ముప్పై ఐదు", "local"))

    async def test_35_rupees_survives_a_provider_dropping_the_five(self):
        source = "మీకు కావాల్సిన పాలు packet ముప్పై ఐదు రూపాయలు"
        primary = AsyncMock(return_value=main.TranslationResult("Meeku kaavalsina paalu packet muppai roopaayalu", source))
        fallback = AsyncMock(return_value=main.TranslationResult("Meeku kaavalsina paalu packet [LFQAA] roopaayalu", "మీకు కావాల్సిన పాలు ప్యాకెట్ [LFQAA] రూపాయలు"))
        with patch.dict(os.environ, {"SARVAM_API_KEY": "test"}), patch("main.gemini_translation", primary), patch("main.sarvam_chat_translation", fallback):
            result = await main.translate_conversation(source, "te-IN", "Telugu", "te-IN", "Tenglish")
        masked, _, _, prompt = primary.call_args.args
        self.assertIn("packet [LFQAA] రూపాయలు", masked)
        self.assertIn("keep it attached to the same item", prompt)
        self.assertEqual(result.display, "Meeku kaavalsina paalu packet 35 roopaayalu")
        self.assertEqual(result.speech_text, source)
        fallback.assert_awaited_once()

    async def test_cross_language_requires_numbers_in_both_outputs(self):
        source = "2 packets for 35 rupees"
        bad_pair = AsyncMock(return_value=json.dumps({
            "display": "[LFQAA] packetlu [LFQAB] roopaayalu",
            "speech_text": "రెండు ప్యాకెట్లు ముప్పై రూపాయలు",
        }))
        with patch.dict(os.environ, {"SARVAM_API_KEY": ""}), patch("main.gemini", bad_pair):
            with self.assertRaisesRegex(main.HTTPException, "original amounts"):
                await main.translate_conversation(source, "en-IN", "English", "te-IN", "Tenglish")

    async def test_telugu_to_tenglish_keeps_original_speech(self):
        source = "నాకు పాలు కావాలి"
        gemini = AsyncMock(return_value=json.dumps({
            "display": "Naaku paalu kaavali",
            "speech_text": "నాకు పాలు అవసరం",
        }))
        with patch.dict(os.environ, {"SARVAM_API_KEY": ""}), patch("main.gemini", gemini):
            result = await main.translate_conversation(source, "te-IN", "Telugu", "te-IN", "Tenglish")
        self.assertEqual(result.display, "Naaku paalu kaavali")
        self.assertEqual(result.speech_text, source)
        self.assertIn("Convert only the script", gemini.call_args.args[1])
        self.assertIn("Do not paraphrase", gemini.call_args.args[1])

    async def test_roman_input_can_keep_display_and_use_native_speech(self):
        source = "Naaku PAALU kaavali!"
        native = "నాకు పాలు కావాలి!"
        gemini = AsyncMock(return_value=native)
        with patch.dict(os.environ, {"SARVAM_API_KEY": ""}), patch("main.gemini", gemini):
            roman = await main.translate_conversation(source, "te-IN", "Tenglish", "te-IN", "Tenglish")
            converted = await main.translate_conversation(source, "te-IN", "Tenglish", "te-IN", "Telugu")
        self.assertEqual((roman.display, roman.speech_text), (source, native))
        self.assertEqual((converted.display, converted.speech_text), (native, native))

    async def test_cross_language_style_uses_fallback_for_wrong_script(self):
        source = "ನನಗೆ ನೀರು ಬೇಕು"
        native = "నాకు నీళ్లు కావాలి"
        primary = AsyncMock(return_value=main.TranslationResult(native, native))
        fallback = AsyncMock(return_value=main.TranslationResult("Naaku neellu kaavali", native))
        with patch.dict(os.environ, {"SARVAM_API_KEY": "test"}), patch("main.gemini_translation", primary), patch("main.sarvam_chat_translation", fallback):
            result = await main.translate_conversation(source, "kn-IN", "Kannada", "te-IN", "Tenglish")
        fallback.assert_awaited_once_with(source, "kn-IN", "Tenglish", ANY, None)
        self.assertEqual((result.display, result.speech_text), ("Naaku neellu kaavali", native))

    async def test_wrong_native_script_fails_after_fallback(self):
        wrong = AsyncMock(return_value=main.TranslationResult("Naaku neellu kaavali", "Naaku neellu kaavali"))
        with patch.dict(os.environ, {"SARVAM_API_KEY": "test"}), patch("main.gemini_translation", wrong), patch("main.sarvam_chat_translation", wrong):
            with self.assertRaises(main.HTTPException) as failure:
                await main.translate_conversation("ನನಗೆ ನೀರು ಬೇಕು", "kn-IN", "Kannada", "te-IN", "Telugu")
        self.assertEqual(failure.exception.status_code, 502)
