import { useSettings } from "./SettingsProvider";
import { useChatHistory, type StoredConversation } from "../chatHistory";
import { postChatForm, useChatRequests, useVoiceCapture } from "../chatRequests";
import { getChatLanguage, getSpokenLanguage } from "../languages";
import { SpeechButton } from "./SpeechButton";

type HistoryMessage = { role: "user" | "bot"; text: string };
type Capture = { language: string; sourceStyle: string; replyStyle: string; replyLanguage: string };
type Reply = { text: string; speechText: string; language: string; style: string };
type Turn = {
  id: string;
  source: { text: string; speechText: string; language: string; style: string };
  request: { style: string; language: string; history: HistoryMessage[] };
  status: "pending" | "ready" | "failed";
  reply?: Reply;
};
type BotConversation = { turns: Turn[]; capture?: Capture };

export default function AIBotPlaceholder({ conversation }: { conversation: StoredConversation }) {
  const { spokenLanguage, chatLanguage } = useSettings();
  const spoken = getSpokenLanguage(spokenLanguage);
  const chat = getChatLanguage(chatLanguage);
  const { updateConversation } = useChatHistory();
  const { run, inFlight } = useChatRequests();
  const { turns, capture: interrupted } = conversation.data as BotConversation;
  const update = (fn: (data: BotConversation) => BotConversation) =>
    updateConversation<BotConversation>(conversation.id, (previous) => {
      const data = fn(previous);
      const titleText = data.turns[0]?.source.text;
      return { data, hasTurns: Boolean(titleText || data.capture), title: titleText ? "AI Bot — " + titleText.slice(0, 48) : "AI Bot" };
    });

  function requestReply(turn: Turn) {
    if (turn.status === "ready") return;
    void run(turn.id, async (signal) => {
      const save = (patch: Pick<Turn, "status" | "reply">) => update((data) => ({
        ...data, turns: data.turns.map((item) => item.id === turn.id ? { ...item, ...patch } : item),
      }));
      save({ status: "pending" });
      try {
        const result = await postChatForm("/api/bot/reply", {
          message: turn.source.text, style: turn.request.style, history: JSON.stringify(turn.request.history),
        }, signal);
        if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error("AI Bot returned no reply.");
        if (!signal.aborted) save({
          status: "ready",
          reply: {
            text: result.reply,
            speechText: result.speech_text || result.reply,
            language: result.speech_language || turn.request.language,
            style: turn.request.style,
          },
        });
      } catch {
        if (!signal.aborted) save({ status: "failed" });
      }
    });
  }

  function addTurn(capture: Capture, text: string) {
    const history = turns.flatMap<HistoryMessage>((turn) => [
      { role: "user", text: turn.source.text },
      ...(turn.reply ? [{ role: "bot" as const, text: turn.reply.text }] : []),
    ]).slice(-12);
    const turn: Turn = {
      id: crypto.randomUUID(),
      source: { text, speechText: text, language: capture.language, style: capture.sourceStyle },
      request: { style: capture.replyStyle, language: capture.replyLanguage, history },
      status: "pending",
    };
    update((data) => ({ ...data, capture: undefined, turns: [...data.turns, turn] }));
    requestReply(turn);
  }

  const voice = useVoiceCapture<Capture>(
    (capture) => update((data) => ({ ...data, capture })),
    addTurn,
  );
  const busy = voice.busy || inFlight.size > 0;
  const status = voice.error || voice.status || (voice.recording ? "Listening… tap again when finished" : "");
  return <main className="ai-chat-screen">
    <section className="ai-chat-card" aria-label="AI Bot conversation">
      <div className="ai-chat-heading"><span className="ai-icon" aria-hidden="true">🤖</span><div><h2>AI Bot</h2><p>Replies in {chat.label}</p></div></div>
      <div className="ai-messages" aria-live="polite">
        {!turns.length && !interrupted && <p className="ai-empty">Tap the microphone and speak in {spoken.label}.</p>}
        {turns.map((turn) => <div className="ai-turn" key={turn.id}>
          <div className="ai-message ai-user-message" data-style={turn.source.style} lang={turn.source.language}>
            <small>You</small><span>{turn.source.text}</span>
            {turn.status !== "ready" && <div className="translation-retry" role="status">
              {inFlight.has(turn.id) ? "AI Bot is replying…" : <>
                <span>{turn.status === "pending" ? "Reply was interrupted." : "AI Bot could not reply."}</span>
                <button type="button" disabled={busy || Boolean(voice.recording)} onClick={() => requestReply(turn)}>Retry reply</button>
              </>}
            </div>}
          </div>
          {turn.reply && <div className="ai-message ai-bot-message" data-style={turn.reply.style} lang={turn.reply.language}>
            <small>AI Bot</small><span>{turn.reply.text}</span>{" "}
            <SpeechButton text={turn.reply.text} speechText={turn.reply.speechText} language={turn.reply.language} />
          </div>}
        </div>)}
        {interrupted && !voice.busy && !voice.recording && <div className="translation-retry" role="status">
          <span>Recording needs to be captured again.</span>
          <button type="button" disabled={busy} onClick={() => voice.start(interrupted)}>Record again</button>
        </div>}
      </div>
      {status && <div className="ai-status" role={voice.error ? "alert" : "status"}>{status}</div>}
      <button className="mic-button owner-mic ai-mic" disabled={busy} onClick={() => voice.recording ? voice.stop() : voice.start({
        language: spoken.tag, sourceStyle: spoken.value, replyStyle: chat.value, replyLanguage: chat.tag,
      })} aria-label={voice.recording ? "Stop recording" : "Start recording in " + spoken.label}>
        🎙 <span>{voice.recording ? "Stop listening" : spoken.label + " mic"}</span>
      </button>
    </section>
  </main>;
}
