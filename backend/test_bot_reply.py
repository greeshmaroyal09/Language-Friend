"""Focused contract tests for /api/bot/reply's Roman-style helpers."""
import json
import os
import time
import unittest
from unittest.mock import ANY, AsyncMock, patch

import main


NATIVE_REPLY = {
    "Tenglish": "2 కిలోల టమాటాలు, 1 కిలో ఉల్లిపాయలు, 3 పాల ప్యాకెట్లు జోడించాను.",
    "Hinglish": "2 किलो टमाटर, 1 किलो प्याज़ और 3 दूध के पैकेट जोड़ दिए हैं।",
    "Kanglish": "2 ಕೆಜಿ ಟೊಮ್ಯಾಟೊ, 1 ಕೆಜಿ ಈರುಳ್ಳಿ ಮತ್ತು 3 ಹಾಲಿನ ಪ್ಯಾಕೆಟ್‌ಗಳನ್ನು ಸೇರಿಸಿದ್ದೇನೆ.",
    "Tanglish": "2 கிலோ தக்காளி, 1 கிலோ வெங்காயம், 3 பால் பாக்கெட்டுகளை சேர்த்துவிட்டேன்.",
}

ROMAN_REPLY = {
    "Tenglish": "2 kilola tamataalu, 1 kilo ullipayalu, 3 paala packets jodinchaanu.",
    "Hinglish": "2 kilo tamatar, 1 kilo pyaaz aur 3 doodh ke packets jod diye hain.",
    "Kanglish": "2 keji tomato, 1 keji eerulli mattu 3 haalu packets serisiddene.",
    "Tanglish": "2 kilo thakkali, 1 kilo vengayam, 3 paal packets serthuvitten.",
}


class RomanBotReplyTests(unittest.TestCase):
    def test_each_roman_style_accepts_a_matching_pair(self):
        for style, speech_text in NATIVE_REPLY.items():
            with self.subTest(style=style):
                response = json.dumps({"display": ROMAN_REPLY[style], "speech_text": speech_text})
                result = main.bot_reply_result(response, style, "test")
                self.assertTrue(main.roman_text_is_valid(result.display))
                self.assertTrue(main.native_text_is_valid(result.speech_text, style))

    def test_wrong_script_display_is_not_renderable_as_a_roman_reply(self):
        response = json.dumps({"display": NATIVE_REPLY["Tenglish"], "speech_text": NATIVE_REPLY["Tenglish"]})
        with self.assertRaises(main.HTTPException):
            main.bot_reply_result(response, "Tenglish", "test")

    def test_invalid_json_can_only_supply_a_native_recovery_source(self):
        candidate = main.bot_reply_candidate(NATIVE_REPLY["Hinglish"], "Hinglish")
        self.assertEqual(main.recovery_source(candidate, "Hinglish"), (NATIVE_REPLY["Hinglish"], "hi-IN", "speech_text"))


class RomanBotReplyRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovery_transliterates_one_native_answer_without_changing_quantities(self):
        native = NATIVE_REPLY["Tenglish"]
        response = json.dumps({"display": native, "speech_text": native})
        transliterate = AsyncMock(return_value="2 kilola tamataalu, 1 kilo ullipayalu, 3 paala packets jodinchaanu.")
        with patch.dict(os.environ, {"SARVAM_API_KEY": "test-key"}), patch("main.sarvam_transliterate_bot_reply", transliterate):
            result = await main.resolve_bot_reply(response, "Tenglish", "sarvam-chat", time.monotonic() + 10, "stop")
        self.assertEqual(result.speech_text, native)
        self.assertTrue(main.roman_text_is_valid(result.display))
        self.assertIn("2", result.display)
        self.assertIn("1", result.display)
        self.assertIn("3", result.display)
        transliterate.assert_awaited_once_with(native, "te-IN", "en-IN", "Tenglish", ANY)

    async def test_recovery_from_latin_only_output_builds_native_speech(self):
        response = json.dumps({"display": "2 kilo tamatar aur 3 doodh packets jod diye", "speech_text": ""})
        native = NATIVE_REPLY["Hinglish"]
        transliterate = AsyncMock(return_value=native)
        with patch.dict(os.environ, {"SARVAM_API_KEY": "test-key"}), patch("main.sarvam_transliterate_bot_reply", transliterate):
            result = await main.resolve_bot_reply(response, "Hinglish", "sarvam-chat", time.monotonic() + 10, "stop")
        self.assertEqual(result.display, "2 kilo tamatar aur 3 doodh packets jod diye")
        self.assertEqual(result.speech_text, native)
        transliterate.assert_awaited_once_with(result.display, "en-IN", "hi-IN", "Hinglish", ANY)


class BotAddressTests(unittest.IsolatedAsyncioTestCase):
    async def test_gemini_and_sarvam_receive_the_same_neutral_address_rule(self):
        reply = json.dumps({"display": "Sare, list cheppandi.", "speech_text": "సరే, లిస్ట్ చెప్పండి."})
        gemini_response = main.httpx.Response(200, json={"candidates": [{
            "content": {"parts": [{"text": reply}]}, "finishReason": "STOP",
        }]})
        sarvam_response = main.httpx.Response(200, json={"choices": [{
            "message": {"content": reply}, "finish_reason": "stop",
        }]})
        client = AsyncMock()
        client.__aenter__.return_value = client
        post = client.post
        post.side_effect = [gemini_response, sarvam_response]
        with (
            patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "SARVAM_API_KEY": "test-key"}),
            patch("main.httpx.AsyncClient", return_value=client),
        ):
            deadline = time.monotonic() + 45
            self.assertIsNotNone(await main.gemini_bot_reply([], "Tenglish", deadline))
            await main.sarvam_bot_reply([], "Tenglish", deadline)
        gemini_instruction = post.await_args_list[0].kwargs["json"]["systemInstruction"]["parts"][0]["text"]
        sarvam_instruction = post.await_args_list[1].kwargs["json"]["messages"][0]["content"]
        self.assertEqual(gemini_instruction, sarvam_instruction)
        self.assertIn("friendly, neutral", gemini_instruction)
        self.assertIn("only if the user explicitly asks", gemini_instruction)
        self.assertIn("translate or quote", gemini_instruction)

    def test_literal_words_requested_by_user_survive_roman_reply_validation(self):
        result = main.bot_reply_result(
            json.dumps({"display": "Akka ani pilichaanu.", "speech_text": "అక్క అని పిలిచాను."}),
            "Tenglish",
            "test",
        )
        self.assertEqual(result.display, "Akka ani pilichaanu.")
        self.assertEqual(result.speech_text, "అక్క అని పిలిచాను.")


if __name__ == "__main__":
    unittest.main()
