// Run with PLAYWRIGHT_MODULE and TEST_BASE_URL. Set LIVE_BACKEND_URL to test the
// real translation, bot, and speech endpoints. Microphone transcription is simulated.
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5179";
const live = process.env.LIVE_BACKEND_URL;
const styleFilter = process.env.TEST_STYLE;
const modeFilter = process.env.TEST_MODE;
const standalone = process.env.TEST_STANDALONE === "1";
const kannada = "ನನಗೆ ನೀರು ಬೇಕು";
const telugu = "నాకు పాలు కావాలి";
const respectfulQuestion = "మీ పేరు ఏంటి?";
const familiarQuestion = "నీ పేరు ఏంటి?";
const hindiRespectful = "आपका नाम क्या है?";
const hindiFamiliar = "तुम्हारा नाम क्या है?";
const hindiReply = "मेरा नाम ग्रीष्मा है।";
const teluguReply = "నా పేరు గ్రీష్మ.";
const hindiInTelugu = "ఆప్‌కా నామ్ క్యా హై?";
const price = "మీకు కావాల్సిన పాలు packet ముప్పై ఐదు రూపాయలు";
const list = "I need 2 kilos of tomatoes and 3 packets of milk.";
const firstBot = "Add 2 kilos of tomatoes to my shopping list.";
const nextBot = "Add 3 packets of milk. Repeat both items with their exact quantities.";
const address = /\b(?:akka|anna|bro|sister|bhai|didi|behen|brother)\b|అక్క|అన్నా|ಅಕ್ಕ|ಅಣ್ಣಾ|அக்கா|அண்ணா|भाई|दीदी|बहन/iu;
const scripts = /[\u0900-\u097f\u0b80-\u0bff\u0c00-\u0cff]/u;
const styles = {
  Tenglish: {
    tag: "te-IN", script: /\p{Script=Telugu}/u, milk: /paal/i,
    language: /\b(?:sare|naaku|mee|unnayi|ches[ae]n\w*|kaav[a-z]+)\b/i,
    two: /\b(?:2|ren(?:d|ḍ)u)\b/i, three: /\b(?:3|m(?:oo|u)(?:d|ḍ)u)\b/i,
    first: ["Naaku paalu kaavali", telugu],
    stock: ["Naaku 2 kilola tamataalu, 3 paala packetlu kaavali", "నాకు 2 కిలోల టమాటాలు, 3 పాల ప్యాకెట్లు కావాలి"],
    acknowledged: ["Sare, listlo 2 kilola tamataalu pettanu", "సరే, లిస్టులో 2 కిలోల టమాటాలు పెట్టాను"],
  },
  Tanglish: {
    tag: "ta-IN", script: /\p{Script=Tamil}/u, milk: /paa?l/i,
    language: /\b(?:sari|ser[a-z]+|enakku|unga|panni[a-z]+|venu[mma]+|vendum|irukku|irukkinrana)\b/i,
    two: /\b(?:2|irandu|rendu)\b/i, three: /\b(?:3|moondru|moonu)\b/i,
    first: ["Enakku paal venum", "எனக்கு பால் வேணும்"],
    stock: ["Enakku 2 kilo thakkaali, 3 paal packet venum", "எனக்கு 2 கிலோ தக்காளி, 3 பால் பாக்கெட் வேணும்"],
    acknowledged: ["Sari, 2 kilo thakkaali listla serthuten", "சரி, 2 கிலோ தக்காளி லிஸ்ட்ல சேர்த்துட்டேன்"],
  },
  Kanglish: {
    tag: "kn-IN", script: /\p{Script=Kannada}/u, milk: /haa?l/i,
    language: /\b(?:sari|nanage|ser[a-z]+|madi[a-z]+|beku|ide|ninna|nimma)\b/i,
    two: /\b(?:2|eradu)\b/i, three: /\b(?:3|mooru|muru)\b/i,
    first: ["Nanage haalu beku", "ನನಗೆ ಹಾಲು ಬೇಕು"],
    stock: ["Nanage 2 kilo tomato, 3 haalina packet beku", "ನನಗೆ 2 ಕಿಲೋ ಟೊಮ್ಯಾಟೊ, 3 ಹಾಲಿನ ಪ್ಯಾಕೆಟ್ ಬೇಕು"],
    acknowledged: ["Sari, 2 kilo tomato list ge seriside", "ಸರಿ, 2 ಕಿಲೋ ಟೊಮ್ಯಾಟೊ ಲಿಸ್ಟ್‌ಗೆ ಸೇರಿಸಿದೆ"],
  },
  Hinglish: {
    tag: "hi-IN", script: /\p{Script=Devanagari}/u, milk: /doodh|dudh/i,
    language: /\b(?:theek|thik|maine|mujhe|aapki|kiye|diye|hain|hai|chahiye)\b/i,
    two: /\b(?:2|do)\b/i, three: /\b(?:3|teen|tin)\b/i,
    first: ["Mujhe doodh chahiye", "मुझे दूध चाहिए"],
    stock: ["Mujhe 2 kilo tamatar aur 3 doodh ke packet chahiye", "मुझे 2 किलो टमाटर और दूध के 3 पैकेट चाहिए"],
    acknowledged: ["Theek hai, list mein 2 kilo tamatar jod diye", "ठीक है, लिस्ट में 2 किलो टमाटर जोड़ दिए"],
  },
};

function fakeWav() {
  const data = Buffer.alloc(44 + 3200);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(3200, 40);
  return data;
}

async function session(browser) {
  const context = await browser.newContext();
  await context.addInitScript((simulateStandalone) => {
    if (simulateStandalone) Object.defineProperty(navigator, "standalone", { get: () => true });
    window.playbackCount = 0;
    document.addEventListener("playing", () => { window.playbackCount += 1; }, { capture: true });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      // Speech playback uses a detached Audio element.
      this.addEventListener("playing", () => { window.playbackCount += 1; }, { once: true });
      return play.apply(this, args);
    };
  }, standalone);
  const calls = [];
  let transcript = "";
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = await new Response(request.postDataBuffer(), {
      headers: { "content-type": request.headers()["content-type"] },
    }).formData();
    const fields = Object.fromEntries(body);
    delete fields.audio;
    const call = { path, ...fields };
    calls.push(call);
    if (path === "/api/transcribe") {
      assert.ok(body.get("audio").size > 44);
      return route.fulfill({ json: { transcript } });
    }
    if (live) {
      const response = await route.fetch({ url: live + path, timeout: 55_000 });
      call.status = response.status();
      if (path !== "/api/speech") {
        const data = await response.json().catch(() => ({}));
        call.provider = data.provider;
        call.display = data.translation ?? data.reply ?? data.pronunciation;
        call.speech = data.speech_text;
      }
      return route.fulfill({ response });
    }
    if (path === "/api/speech") return route.fulfill({ contentType: "audio/wav", body: fakeWav() });
    if (path === "/api/conversations/pronunciation") {
      const pronunciation = fields.message === hindiRespectful ? (fields.script === "Latin" ? "Aapka naam kya hai?" : hindiInTelugu)
        : fields.message === hindiFamiliar ? "Tumhara naam kya hai?" : "Naaku neellu kaavali";
      return route.fulfill({ json: { pronunciation } });
    }
    if (path === "/api/bot/reply") {
      const config = styles[fields.style];
      const [reply, speech_text] = fields.message === firstBot ? config.acknowledged : config.stock;
      call.provider = "simulated";
      return route.fulfill({ json: { reply, speech_text, speech_language: config.tag } });
    }
    assert.equal(path, "/api/conversations/text");
    const config = styles[fields.target_style];
    const result = fields.target_style === "Hindi" ? Array(2).fill(fields.message === respectfulQuestion ? hindiRespectful : hindiFamiliar)
      : fields.message === hindiReply ? [fields.target_style === "Telugu" ? teluguReply : "Naa peru Greeshma.", teluguReply]
      : fields.target_style === "Telugu" ? ["నాకు నీళ్లు కావాలి", "నాకు నీళ్లు కావాలి"]
      : fields.message === kannada ? ["Naaku neellu kaavali", "నాకు నీళ్లు కావాలి"]
      : fields.message === price ? ["Meeku kaavalsina paala packet 35 rupaayalu", price]
      : fields.message === list ? config.stock : config.first;
    call.provider = "simulated";
    return route.fulfill({ json: { translation: result[0], speech_text: result[1] } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(live ? 55_000 : 12_000);
  const click = (name) => page.getByRole("button", { name, exact: true }).click();
  const pref = async (spoken, style, theme) => {
    await click("Open Settings");
    await page.getByLabel("My language", { exact: true }).selectOption(spoken);
    await page.getByLabel("My Chat Language").selectOption(style);
    if (theme) await page.getByLabel("Chat theme").selectOption(theme);
    await click("Open Settings");
  };
  const partner = async (language) => {
    await click("Choose the other person's language");
    await page.getByRole("option", { name: language, exact: true }).click();
  };
  const typed = async (language, text) => {
    await click(language === "owner" ? "Type your message" : "Type the other person's message");
    await page.getByRole("textbox").fill(text);
    await click("Send");
  };
  const mic = async (language, text) => {
    transcript = text;
    await click("Start recording in " + language);
    await page.getByRole("button", { name: "Stop recording", exact: true }).waitFor();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await click("Stop recording");
  };
  const fresh = async (mode) => { await click("New Chat menu"); await click(mode); };
  const delivered = async (selector, index) => {
    const element = page.locator(selector).nth(index);
    await element.getByRole("button", { name: /^Play audio: / }).waitFor();
    return element;
  };
  const tap = async (element, config, speechExpected) => {
    for (let attempt = 0; attempt < (live ? 2 : 1); attempt++) {
      const prior = calls.filter(({ path }) => path === "/api/speech").length;
      const priorPlay = await page.evaluate(() => window.playbackCount);
      await element.getByRole("button", { name: /^(?:Play|Retry) audio: / }).click();
      const played = await Promise.race([
        page.waitForFunction((before) => window.playbackCount > before, priorPlay).then(() => true),
        element.getByRole("button", { name: /^Retry audio: / }).waitFor().then(() => false),
      ]);
      const speechRequests = calls.filter(({ path }) => path === "/api/speech");
      assert.equal(speechRequests.length, prior + 1);
      const speech = speechRequests.at(-1);
      assert.equal(speech.language, config.tag);
      assert.match(speech.text, config.script);
      if (speechExpected) assert.equal(speech.text, speechExpected);
      if (played) return speech.text;
    }
    throw new Error("TTS failed to play after tapping the speaker button.");
  };
  await page.goto(base);
  if (standalone) await page.waitForFunction(() => navigator.standalone && navigator.serviceWorker.controller);
  return { page, calls, pref, partner, typed, mic, fresh, delivered, tap, close: () => context.close() };
}

async function reproduction(browser, theme, input = "mic") {
  const test = await session(browser);
  try {
    await test.pref("Kannada", "Tenglish", theme);
    await test.partner("తెలుగు");
    if (input === "mic") await test.mic("Kannada", kannada);
    else await test.typed("owner", kannada);
    const water = await test.delivered(".owner-bubble", 0);
    const opposite = await test.delivered(".other-bubble", 0);
    if (input === "mic") await test.mic("Telugu", telugu);
    else await test.typed("other", telugu);
    const milk = await test.delivered(".owner-bubble", 1);
    const texts = await test.page.locator(".owner-bubble > span:first-child").allTextContents();
    assert.equal(texts.length, 2);
    assert.equal(await test.page.locator(".other-bubble").count(), 1);
    assert.match(texts[0], /n(?:ee|i)[lr]/i);
    assert.match(texts[1], /paa?l/i);
    assert.ok(texts.every((text) => !scripts.test(text)));
    assert.match(await opposite.locator("span").first().innerText(), styles.Tenglish.script);
    assert.equal(await test.page.getByText(kannada, { exact: true }).count(), 0);
    assert.equal(await test.page.getByText(telugu, { exact: true }).count(), 0);
    assert.deepEqual(test.calls.filter(({ path }) => path === "/api/transcribe").map(({ language }) => language),
      input === "mic" ? ["kn-IN", "te-IN"] : []);
    assert.deepEqual(test.calls.filter(({ path }) => path === "/api/conversations/text").map(({ source_language, target_style }) => [source_language, target_style]).sort(),
      [["kn-IN", "Telugu"], ["te-IN", "Tenglish"]].sort());
    const pronunciations = test.calls.filter(({ path }) => path === "/api/conversations/pronunciation");
    assert.equal(pronunciations.length, 1);
    assert.equal(pronunciations[0].language, "te-IN");
    assert.equal(pronunciations[0].script, "Latin");
    assert.equal(pronunciations[0].message, await opposite.locator("span").first().innerText());
    assert.equal(await test.page.evaluate(() => window.playbackCount), 0);
    assert.equal(test.calls.filter(({ path }) => path === "/api/speech").length, 0);
    const sources = [...new Set(test.calls.filter(({ path }) => path === "/api/conversations/text").map(({ message }) => message))];
    assert.deepEqual(sources, [kannada, telugu]);
    assert.equal(await test.page.evaluate(() => localStorage.getItem("language-friend.chat-history.v1")), null);
    await test.tap(water, styles.Tenglish);
    await test.tap(milk, styles.Tenglish, telugu);
    console.log(theme, input, "exact reproduction: 2 owner / 1 opposite", texts.join(" | "));
    if (theme === "black-red" && input === "mic") {
      await test.typed("other", price);
      const amount = await test.delivered(".owner-bubble", 2);
      const amountText = await amount.locator("span").first().innerText();
      assert.match(amountText, /\b35\b/);
      assert.doesNotMatch(amountText, /\b30\b/);
      assert.match(amountText, /r(?:u+|o+)p/i);
      assert.doesNotMatch(amountText, scripts);
      assert.equal(await test.page.locator(".other-bubble").count(), 1);
      await test.tap(amount, styles.Tenglish, price);
      console.log("Price typed in UI:", amountText);
    }
  } finally { await test.close(); }
}

async function styleCheck(browser, style, mode) {
  const config = styles[style];
  const test = await session(browser);
  try {
    await test.pref("English", style);
    const human = mode === "Human Chat";
    const selector = human ? ".owner-bubble" : ".ai-bot-message";
    if (human) {
      await test.partner("English");
      await test.typed("other", "I need milk.");
    } else {
      await test.fresh("AI Bot");
      await test.mic("English", firstBot);
    }
    const first = await test.delivered(selector, 0);
    const firstText = await first.locator("span").first().innerText();
    if (human) await test.typed("other", list);
    else await test.mic("English", nextBot);
    const second = await test.delivered(selector, 1);
    const secondText = await second.locator("span").first().innerText();
    for (const text of [firstText, secondText]) {
      assert.match(text, /[a-z]/i);
      assert.doesNotMatch(text, scripts);
      assert.match(text, config.language);
      if (!human) assert.doesNotMatch(text, address);
    }
    assert.match(secondText, config.two);
    assert.match(secondText, config.three);
    // Code-mixed bot replies may use an English item name. The surrounding
    // words above still need to be in the selected language.
    assert.match(secondText, human ? config.milk : new RegExp(config.milk.source + "|milk", "i"));
    assert.match(secondText, /tamaat|tam[aā]t|tomato|th?akk(?:aa?|ā)l/i);
    if (human) assert.match(firstText, config.milk);
    else assert.equal(JSON.parse(test.calls.filter(({ path }) => path === "/api/bot/reply").at(-1).history)[0].text, firstBot);
    assert.equal(test.calls.filter(({ path }) => path === "/api/speech").length, 0);
    assert.equal(await test.page.evaluate(() => window.playbackCount), 0);
    const outputs = test.calls.filter(({ path }) => path === (human ? "/api/conversations/text" : "/api/bot/reply"));
    for (const [index, element] of [first, second].entries()) {
      const speech = await test.tap(element, config, outputs[index].speech);
      if (!human) assert.doesNotMatch(speech, address);
    }
    console.log(mode, style, "PASS", outputs.map(({ provider }) => provider).join(" / "), firstText + " | " + secondText);
  } catch (error) {
    const evidence = test.calls.filter(({ path }) => path !== "/api/transcribe").map(({ path, status, provider, display }) => ({ path, status, provider, display }));
    throw new Error(mode + " " + style + ": " + JSON.stringify(evidence), { cause: error });
  } finally { await test.close(); }
}

async function hindiExchange(browser, style) {
  const test = await session(browser);
  try {
    const latin = style === "Tenglish";
    await test.pref("Telugu", style);
    await test.partner("हिन्दी");
    await test.mic("Telugu", respectfulQuestion);
    const outgoing = await test.delivered(".owner-bubble", 0);
    const opposite = await test.delivered(".other-bubble", 0);
    assert.equal(await outgoing.locator("span").first().innerText(), latin ? "Aapka naam kya hai?" : hindiInTelugu);
    assert.equal(await opposite.locator("span").first().innerText(), hindiRespectful);
    await test.mic("Hindi", hindiReply);
    const incoming = await test.delivered(".owner-bubble", 1);
    assert.equal(await incoming.locator("span").first().innerText(), latin ? "Naa peru Greeshma." : teluguReply);
    assert.equal(await test.page.locator(".owner-bubble").count(), 2);
    assert.equal(await test.page.locator(".other-bubble").count(), 1);
    assert.equal(await test.page.getByText(hindiReply, { exact: true }).count(), 0);
    assert.equal(test.calls.filter(({ path }) => path === "/api/speech").length, 0);
    assert.deepEqual(test.calls.filter(({ path }) => path === "/api/conversations/text")
      .map(({ message, source_language, target_style }) => [message, source_language, target_style]),
      [[respectfulQuestion, "te-IN", "Hindi"], [hindiReply, "hi-IN", style]]);
    assert.deepEqual(test.calls.filter(({ path }) => path === "/api/conversations/pronunciation")
      .map(({ message, language, script }) => [message, language, script]),
      [[hindiRespectful, "hi-IN", latin ? "Latin" : "Telugu"]]);
    await test.tap(outgoing, styles.Hinglish, hindiRespectful);
    await test.tap(opposite, styles.Hinglish, hindiRespectful);
    await test.tap(incoming, styles.Tenglish, teluguReply);
    if (latin) {
      await test.typed("owner", familiarQuestion);
      assert.equal(await (await test.delivered(".owner-bubble", 2)).locator("span").first().innerText(), "Tumhara naam kya hai?");
      assert.equal(await (await test.delivered(".other-bubble", 1)).locator("span").first().innerText(), hindiFamiliar);
    }
    console.log("Hindi ↔ Telugu in", style, "PASS — both scripts and speech locales");
  } finally { await test.close(); }
}

async function run() {
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    let failed = false;
    if (!styleFilter || styleFilter === "reproduction" || styleFilter === "hindi") {
      for (const style of ["Tenglish", "Telugu"]) {
        try { await hindiExchange(browser, style); }
        catch (error) { failed = true; console.error("Hindi exchange", style, error); }
      }
    }
    if (!styleFilter || styleFilter === "reproduction") {
      for (const [theme, input] of live ? [["black-red", "mic"]] : [["black-red", "mic"], ["light", "mic"], ["light", "typed"]]) {
        try { await reproduction(browser, theme, input); }
        catch (error) { failed = true; console.error(theme, input, error); }
      }
    }
    for (const style of Object.keys(styles).filter((name) => !styleFilter || name === styleFilter)) {
      for (const mode of ["Human Chat", "AI Bot"].filter((name) => !modeFilter || name === modeFilter)) {
        try { await styleCheck(browser, style, mode); }
        catch (error) { failed = true; console.error(error); }
      }
    }
    if (failed) process.exitCode = 1;
  } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
