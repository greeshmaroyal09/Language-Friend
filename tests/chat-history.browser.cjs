// Run against a local Vite server with PLAYWRIGHT_MODULE pointing to Playwright.
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5179";
const teluguMilk = "నాకు పాలు కావాలి";
const kannadaWater = "ನನಗೆ ನೀರು ಬೇಕು";
const kannadaMilk = "ನನಗೆ ಹಾಲು ಬೇಕು";
const teluguWater = "నాకు నీళ్లు కావాలి";
const milk = "Naaku paalu kaavali";
const kannadaPronunciation = "Nanage haalu beku";
const water = "Naaku neellu kaavali";
const historyKey = "language-friend.chat-history.v1";
const savedAt = "2026-11-23T06:00:00.000Z";
const legacyHuman = {
  id: "legacy-human", mode: "human", title: "Human Chat — Legacy human message", createdAt: savedAt, updatedAt: savedAt, hasTurns: true,
  data: {
    partner: "Kannada",
    turns: [{
      id: "legacy-human-turn", speaker: "owner",
      source: { text: "Legacy human message", language: "te-IN", style: "Tenglish" },
      owner: { style: "Tenglish", language: "te-IN", status: "ready", text: "Legacy human message" },
    }],
  },
};
const legacyBot = {
  id: "legacy-bot", mode: "ai", title: "AI Bot — Legacy bot message", createdAt: savedAt, updatedAt: savedAt, hasTurns: true,
  data: {
    turns: [{
      id: "legacy-bot-turn", status: "ready",
      source: { text: "Legacy bot message", speechText: "Legacy bot message", language: "te-IN", style: "Telugu" },
      request: { style: "Tenglish", language: "te-IN", history: [] },
      reply: { text: "Already saved", speechText: "సరే!", language: "te-IN", style: "Tenglish" },
    }],
  },
};
const legacyStore = { version: 1, active: { human: legacyHuman.id, ai: legacyBot.id }, conversations: [legacyHuman, legacyBot] };
let transcript = kannadaWater;
let failTranslation = false;
let failPronunciation = true;
let holdTranslation;
let markTranslationStarted;
let failReply = false;
let holdReply;
let markReplyStarted;
const calls = [];

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const context = await browser.newContext();
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = await new Response(request.postDataBuffer(), {
        headers: { "content-type": request.headers()["content-type"] },
      }).formData();
      const fields = Object.fromEntries(body);
      delete fields.audio;
      calls.push({ path, ...fields });
      if (path === "/api/transcribe") {
        assert.ok(body.get("audio").size > 44);
        return route.fulfill({ json: { transcript } });
      }
      if (path === "/api/speech") return route.fulfill({ status: 502, json: { detail: "Speech payload captured" } });
      if (path === "/api/conversations/pronunciation") {
        assert.deepEqual(fields, { message: kannadaMilk, language: "kn-IN", script: "Latin" });
        if (failPronunciation) return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: { pronunciation: kannadaPronunciation } });
      }
      if (path === "/api/bot/reply") {
        if (fields.message === "Pending bot" && holdReply) {
          markReplyStarted();
          await holdReply;
          if (request.failure()) return;
        }
        if (failReply) return route.fulfill({ status: 503, json: {} });
        if (fields.style === "Kannada") return route.fulfill({ json: { reply: "ಸರಿ!", speech_text: "ಸರಿ!", speech_language: "kn-IN" } });
        return route.fulfill({ json: { reply: "Sare!", speech_text: "సరే!", speech_language: "te-IN" } });
      }
      assert.equal(path, "/api/conversations/text");
      if (failTranslation && fields.message === "retry this") {
        return route.fulfill({ status: 503, json: {} });
      }
      if (fields.message === "interrupted" && holdTranslation) {
        markTranslationStarted();
        await holdTranslation;
        if (request.failure()) return;
      }
      const translated = fields.target_style === "Kannada" ? [kannadaMilk, kannadaMilk]
        : fields.target_style === "Telugu" ? [teluguWater, teluguWater]
        : fields.message === kannadaWater ? [water, teluguWater] : [milk, teluguMilk];
      await route.fulfill({ json: { translation: translated[0], speech_text: translated[1] } }).catch((error) => {
        if (!request.failure()) throw error;
      });
    });
    let page = await context.newPage();
    const click = (name) => page.getByRole("button", { name, exact: true }).click();
    const settings = () => click("Open Settings");
    const newChat = async (name) => { await click("New Chat menu"); await click(name); };
    const partner = async () => {
      await click("Choose the other person's language");
      await page.getByRole("option", { name: "ಕನ್ನಡ", exact: true }).click();
    };
    const type = async (side, message) => {
      await click(side === "owner" ? "Type your message" : "Type the other person's message");
      await page.getByRole("textbox").fill(message);
      await click("Send");
    };
    const mic = async (language, message) => {
      transcript = message;
      await click("Start recording in " + language);
      await page.getByRole("button", { name: "Stop recording", exact: true }).waitFor();
      // The real recorder rejects audio shorter than 250 ms.
      await new Promise((resolve) => setTimeout(resolve, 850));
      await click("Stop recording");
    };
    const texts = (side) => page.locator("." + side + "-bubble > span:first-child").allTextContents();
    const bubble = (side, message) => page.locator("." + side + "-bubble").getByText(message, { exact: true }).waitFor();
    const history = (title) => page.getByRole("button", { name: new RegExp(title) });
    const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), historyKey);
    const emptyHuman = async () => {
      await page.getByRole("button", { name: "Choose the other person's language" }).waitFor();
      assert.deepEqual(await texts("owner"), []);
      assert.deepEqual(await texts("other"), []);
      assert.equal(await page.getByRole("button", { name: "Retry translation", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Type your message", exact: true }).isEnabled(), false);
    };
    const speak = async (display, speechText) => {
      const before = calls.length;
      await click("Play audio: " + display);
      await page.getByText("Speech payload captured", { exact: true }).waitFor();
      assert.deepEqual(calls.slice(before), [{ path: "/api/speech", text: speechText, language: "te-IN" }]);
    };

    await page.goto(base);
    await emptyHuman();
    assert.equal(await stored(), null);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: historyKey, value: legacyStore });
    await page.reload();
    await emptyHuman();
    await settings();
    assert.equal(await page.locator(".chat-history button").count(), 1);
    assert.equal(await history("AI Bot — Legacy bot message").count(), 1);
    assert.equal(await history("Human Chat — Legacy human message").count(), 0);
    await page.getByLabel("My language", { exact: true }).selectOption("Telugu");
    await page.getByLabel("My Chat Language").selectOption("Tenglish");
    await settings();
    await partner();
    await type("owner", teluguMilk);
    await bubble("other", kannadaMilk);
    await page.getByRole("button", { name: "Retry translation", exact: true }).waitFor();
    failPronunciation = false;
    await click("Retry translation");
    await bubble("owner", kannadaPronunciation);
    assert.equal(calls.filter(({ path }) => path === "/api/conversations/text").length, 1);
    assert.equal(calls.filter(({ path }) => path === "/api/conversations/pronunciation").length, 2);
    assert.deepEqual(await texts("owner"), [kannadaPronunciation]);
    assert.deepEqual(await texts("other"), [kannadaMilk]);
    await mic("Kannada", kannadaWater);
    await bubble("owner", water);
    assert.deepEqual(await texts("owner"), [kannadaPronunciation, water]);
    assert.deepEqual(await texts("other"), [kannadaMilk]);
    assert.equal(await page.getByText(teluguMilk, { exact: true }).count(), 0);
    assert.equal(await page.getByText(kannadaWater, { exact: true }).count(), 0);
    assert.equal(calls.filter((call) => call.path === "/api/transcribe").at(-1).language, "kn-IN");
    await mic("Telugu", teluguMilk);
    await page.waitForFunction(() => document.querySelectorAll(".other-bubble").length === 2);
    await page.waitForFunction(() => document.querySelectorAll(".owner-bubble").length === 3);
    await type("other", kannadaWater);
    await page.waitForFunction(() => document.querySelectorAll(".owner-bubble").length === 4);
    assert.deepEqual(await texts("owner"), [kannadaPronunciation, water, kannadaPronunciation, water]);
    assert.deepEqual(await texts("other"), [kannadaMilk, kannadaMilk]);
    console.log("Human Chat exact bubble counts and scripts passed for typed and mic input in both directions");

    failTranslation = true;
    await type("other", "retry this");
    await page.getByRole("button", { name: "Retry translation", exact: true }).waitFor();
    assert.equal(await page.getByText("retry this", { exact: true }).count(), 0);
    await settings();
    assert.equal(await page.locator(".chat-history button").count(), 1);
    await page.getByLabel("My Chat Language").selectOption("Telugu");
    await settings();
    assert.deepEqual(await texts("owner"), [kannadaPronunciation, water, kannadaPronunciation, water]);
    assert.equal(calls.filter(({ path }) => path === "/api/speech").length, 0);
    const beforeSpeech = calls.length;
    await page.getByRole("button", { name: "Play audio: " + kannadaPronunciation, exact: true }).first().click();
    await page.getByText("Speech payload captured", { exact: true }).waitFor();
    assert.deepEqual(calls.slice(beforeSpeech), [{ path: "/api/speech", text: kannadaMilk, language: "kn-IN" }]);
    failTranslation = false;
    const beforeRetry = calls.length;
    await page.getByRole("button", { name: "Retry translation", exact: true }).evaluate((button) => { button.click(); button.click(); });
    await page.getByRole("button", { name: "Retry translation", exact: true }).waitFor({ state: "detached" });
    assert.equal(calls.length, beforeRetry + 1);
    assert.equal(calls.at(-1).target_style, "Tenglish");
    await type("other", kannadaWater);
    await bubble("owner", teluguWater);
    assert.deepEqual(await texts("owner"), [kannadaPronunciation, water, kannadaPronunciation, water, milk, teluguWater]);
    let releaseTranslation;
    holdTranslation = new Promise((resolve) => { releaseTranslation = resolve; });
    const translationStarted = new Promise((resolve) => { markTranslationStarted = resolve; });
    await type("other", "interrupted");
    await page.getByText("Translating…", { exact: true }).waitFor();
    await translationStarted;
    await newChat("Human Chat");
    await emptyHuman();
    releaseTranslation();
    holdTranslation = null;
    await partner();
    await type("other", kannadaWater);
    await bubble("owner", teluguWater);
    const beforeRefresh = calls.length;
    await page.reload();
    await emptyHuman();
    assert.equal(calls.length, beforeRefresh);
    assert.deepEqual(await stored(), legacyStore);
    await settings();
    assert.equal(await page.locator(".chat-history button").count(), 1);
    assert.equal(await history("AI Bot — Legacy bot message").count(), 1);
    console.log("Human Chat worked in memory, added no history, ignored legacy active chat and reset on New Chat and refresh");

    await page.getByLabel("My Chat Language").selectOption("Tenglish");
    await settings();
    await page.goto(base + "/ai");
    await page.getByText("Legacy bot message", { exact: true }).waitFor();
    await page.getByText("Already saved", { exact: true }).waitFor();
    await newChat("AI Bot");
    await mic("Telugu", "First bot");
    await page.getByText("Sare!", { exact: true }).waitFor();
    failReply = true;
    await mic("Telugu", "Failed bot");
    await page.getByRole("button", { name: "Retry reply", exact: true }).waitFor();
    failReply = false;
    await newChat("AI Bot");
    await mic("Telugu", "Second bot");
    await page.getByText("Sare!", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("Second bot", { exact: true }).waitFor();
    await page.close();
    page = await context.newPage();
    await page.goto(base + "/ai");
    await page.getByText("Second bot", { exact: true }).waitFor();
    const beforeBotRestore = calls.length;
    await settings();
    await page.getByLabel("My Chat Language").selectOption("Kannada");
    await history("AI Bot — First bot").click();
    await page.getByText("Failed bot", { exact: true }).waitFor();
    assert.equal(calls.length, beforeBotRestore);
    await speak("Sare!", "సరే!");
    await click("Retry reply");
    await page.getByRole("button", { name: "Retry reply", exact: true }).waitFor({ state: "detached" });
    assert.equal(calls.at(-1).style, "Tenglish");
    assert.deepEqual(JSON.parse(calls.at(-1).history), [{ role: "user", text: "First bot" }, { role: "bot", text: "Sare!" }]);
    await mic("Telugu", "Continue bot");
    await page.getByText("Continue bot", { exact: true }).waitFor();
    await page.getByText("ಸರಿ!", { exact: true }).waitFor();
    assert.equal(await page.locator(".ai-bot-message").count(), 3);
    assert.equal(calls.at(-1).style, "Kannada");
    assert.deepEqual(JSON.parse(calls.at(-1).history).filter(({ role }) => role === "user").map(({ text }) => text), ["First bot", "Failed bot"]);
    await settings();
    assert.equal(await history("AI Bot — Second bot").count(), 1);
    assert.equal(await history("AI Bot — Legacy bot message").count(), 1);
    assert.equal(await history("Human Chat").count(), 0);
    await settings();
    let releaseReply;
    holdReply = new Promise((resolve) => { releaseReply = resolve; });
    const replyStarted = new Promise((resolve) => { markReplyStarted = resolve; });
    await mic("Telugu", "Pending bot");
    await replyStarted;
    await page.reload();
    releaseReply();
    holdReply = null;
    const beforeRestoredReply = calls.length;
    await page.getByText("Reply was interrupted.", { exact: true }).waitFor();
    assert.equal(calls.length, beforeRestoredReply);
    await click("Retry reply");
    await page.getByRole("button", { name: "Retry reply", exact: true }).waitFor({ state: "detached" });
    assert.equal(calls.length, beforeRestoredReply + 1);
    assert.equal(await page.locator(".ai-bot-message").count(), 4);
    const saved = await stored();
    assert.doesNotMatch(JSON.stringify(saved), /"(audio|api[_-]?key|blob)"\s*:/i);
    assert.deepEqual(saved.conversations.find(({ id }) => id === legacyBot.id), legacyBot);
    assert.ok(saved.conversations.every(({ mode }) => mode === "ai"));
    assert.deepEqual(Object.keys(saved.active), ["ai"]);
    console.log("AI Bot two-conversation history, tab reopening, silent restore, failed and pending retry, continuation and saved speech payload passed");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
