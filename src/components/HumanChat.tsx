import { useEffect, useRef, useState } from "react";
import { useSettings } from "./SettingsProvider";
import { postChatForm, useChatRequests, useVoiceCapture } from "../chatRequests";
import { PARTNER_LANGUAGES, getChatLanguage, getSpokenLanguage, typedLanguage, isRomanStyle, type ChatLanguage } from "../languages";
import { SpeechButton } from "./SpeechButton";

type Side = "owner" | "other";
type Language = Pick<ChatLanguage, "tag" | "value">;
type Source = { text: string; language: string; style: string };
type Capture = { language: string; style: string; speaker: Side; chat: Language; partner: Language };
type Delivery = {
  style: string;
  language: string;
  status: "pending" | "ready" | "failed";
  text?: string;
  speechText?: string;
};
type Turn = { id: string; source: Source; owner: Delivery; other?: Delivery };
type HumanConversation = { partner: string | null; turns: Turn[]; capture?: Capture };

function deliveryFor(source: Source, target: Language): Delivery {
  const sameStyle = source.language === target.tag && source.style === target.value;
  const needsSpeechScript = sameStyle && isRomanStyle(target.value) && /[a-z]/i.test(source.text);
  return {
    style: target.value,
    language: target.tag,
    status: sameStyle && !needsSpeechScript ? "ready" : "pending",
    text: sameStyle ? source.text : undefined,
    speechText: sameStyle && !needsSpeechScript ? source.text : undefined,
  };
}

const readingScript = (style: string) => style === "English" || isRomanStyle(style) ? "Latin" : style;

async function translate(source: Source, target: Delivery, signal: AbortSignal): Promise<Delivery> {
  const result = await postChatForm("/api/conversations/text", {
    message: source.text,
    source_language: source.language,
    source_style: source.style,
    target_language: target.language,
    target_style: target.style,
  }, signal);
  if (typeof result.translation !== "string" || !result.translation.trim() ||
      typeof result.speech_text !== "string" || !result.speech_text.trim()) throw new Error("Translation returned no text.");
  return { ...target, status: "ready", text: target.text ?? result.translation, speechText: result.speech_text };
}

function Bubble({ side, delivery }: { side: Side; delivery: Delivery }) {
  if (!delivery.text) return null;
  return (
    <div className={"chat-bubble " + side + "-bubble"} data-style={delivery.style} lang={delivery.language}>
      <span>{delivery.text}</span>
      {delivery.speechText && <SpeechButton text={delivery.text} speechText={delivery.speechText} language={delivery.language} />}
    </div>
  );
}

export default function HumanChat() {
  const { spokenLanguage, chatLanguage } = useSettings();
  const { run, inFlight } = useChatRequests();
  const [{ partner: partnerValue, turns, capture: interrupted }, updateConversation] = useState<HumanConversation>({
    partner: null,
    turns: [],
  });
  const spoken = getSpokenLanguage(spokenLanguage);
  const chat = getChatLanguage(chatLanguage);
  const partner = PARTNER_LANGUAGES.find((language) => language.value === partnerValue);
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState<Side | null>(null);
  const [draft, setDraft] = useState("");
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function deliver(turn: Turn) {
    if (turn.owner.status === "ready") return;
    void run(turn.id, async (signal) => {
      const save = (owner: Delivery, other?: Delivery) => updateConversation((data) => ({
        ...data,
        turns: data.turns.map((item) => item.id === turn.id ? { ...item, owner, other } : item),
      }));
      const owner = { ...turn.owner, status: "pending" as const };
      let other = turn.other;
      save(owner, other);
      try {
        if (!other) {
          const incoming = await translate(turn.source, owner, signal);
          if (!signal.aborted) save(incoming);
          return;
        }
        // The opposite bubble and both speaker buttons use the same native translation.
        if (other.status !== "ready") other = await translate(turn.source, other, signal);
        if (signal.aborted) return;
        if (!other.text) throw new Error("Translation returned no text.");
        const script = readingScript(owner.style);
        let text = other.text;
        if (script !== readingScript(other.style)) {
          save(owner, other);
          const result = await postChatForm("/api/conversations/pronunciation", {
            message: other.text,
            language: other.language,
            script,
          }, signal);
          if (typeof result.pronunciation !== "string" || !result.pronunciation.trim()) throw new Error("Pronunciation returned no text.");
          text = result.pronunciation;
        }
        if (!signal.aborted) save({ ...owner, status: "ready", text, speechText: other.speechText }, other);
      } catch {
        if (!signal.aborted) save({ ...owner, status: "failed" }, other);
      }
    });
  }

  function addTurn(capture: Capture, text: string, fromMic: boolean) {
    const source = { text, language: capture.language, style: capture.style };
    const other = capture.speaker === "owner" ? deliveryFor(source, capture.partner) : undefined;
    const owner: Delivery = other
      ? readingScript(capture.chat.value) === readingScript(other.style)
        ? { ...other, style: capture.chat.value }
        : { style: capture.chat.value, language: other.language, status: "pending" }
      : deliveryFor(source, capture.chat);
    const turn: Turn = { id: crypto.randomUUID(), source, owner, other };
    updateConversation((data) => ({ ...data, turns: [...data.turns, turn], capture: fromMic ? undefined : data.capture }));
    deliver(turn);
  }

  const voice = useVoiceCapture<Capture>(
    (capture) => updateConversation((data) => ({ ...data, capture })),
    (capture, text) => {
      const source = typedLanguage(text, getChatLanguage(capture.style));
      addTurn({ ...capture, language: source.tag, style: source.value }, text, true);
    },
  );
  const captureFor = (speaker: Side, source: Language, recipient: Language): Capture => ({
    speaker, language: source.tag, style: source.value, chat, partner: recipient,
  });
  const mic = (side: Side) => {
    if (voice.recording?.speaker === side) voice.stop();
    else if (partner) voice.start(captureFor(side, side === "owner" ? spoken : partner, partner));
  };
  const input = (side: Side) => typing === side && (
    <form className="text-entry" onSubmit={(event) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || !partner || voice.busy || voice.recording) return;
      const source = typedLanguage(text, side === "owner" ? chat : partner);
      addTurn(captureFor(side, source, partner), text, false);
      setDraft("");
      setTyping(null);
    }}>
      <input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus
        aria-label={side === "owner" ? "Your message" : "Other person's message"}
        placeholder={"Type in " + (side === "owner" ? chat.label : partner?.value ?? "their language")} />
      <button type="submit" disabled={!draft.trim() || voice.busy || Boolean(voice.recording)}>Send</button>
    </form>
  );
  const controls = (side: Side) => {
    const language = side === "owner" ? spoken.value : partner?.value ?? "Other person";
    const listening = voice.recording?.speaker === side;
    return <div className="chat-controls">
      <button className={"mic-button " + side + "-mic"} disabled={!partner || voice.busy || Boolean(voice.recording && !listening)}
        onClick={() => mic(side)} aria-label={listening ? "Stop recording" : "Start recording in " + language}>
        🎙 <span>{listening ? "Stop listening" : language + " mic"}</span>
      </button>
      <button className="keyboard-button" disabled={!partner || voice.busy || Boolean(voice.recording)}
        onClick={() => { setTyping(typing === side ? null : side); setDraft(""); }}
        aria-label={side === "owner" ? "Type your message" : "Type the other person's message"}>⌨</button>
    </div>;
  };
  const voiceStatus = voice.error || voice.status || (voice.recording ? "Listening…" : "");

  return <main className="human-chat-container">
    <div className="diagonal-backdrop" aria-hidden="true"><div className="diagonal-other-area" /><div className="diagonal-owner-area" /></div>
    {voiceStatus && <div className="voice-notice" role={voice.error ? "alert" : "status"}>{voiceStatus}</div>}
    <section className="conversation-area other-person-area" aria-label="Other person's conversation area">
      {controls("other")}{input("other")}
      <div className="bubbles-container other-bubbles">{turns.map((turn) => turn.other && <Bubble key={turn.id} side="other" delivery={turn.other} />)}</div>
    </section>
    <div className="center-lang-wrapper" ref={menu}>
      <button className="lang-control" onClick={() => setOpen(!open)} aria-label="Choose the other person's language" aria-haspopup="listbox" aria-expanded={open}>
        <span>LANG{partner && " · " + partner.nativeLabel}</span>
        <svg className="lang-chevron" viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1.5 5 5 5-5" /></svg>
      </button>
      {open && <ul className="lang-dropdown-menu" role="listbox" aria-label="Other person's language">{PARTNER_LANGUAGES.map((language) => (
        <li className="lang-menu-item" key={language.value}><button onClick={() => {
          updateConversation((data) => ({ ...data, partner: language.value }));
          setOpen(false);
        }} role="option" aria-selected={partner?.value === language.value}>{language.nativeLabel}</button></li>
      ))}</ul>}
    </div>
    <section className="conversation-area owner-area" aria-label="Your conversation area">
      <div className="bubbles-container owner-bubbles">
        {turns.map((turn) => {
          return <div className="human-turn" key={turn.id}>
            <Bubble side="owner" delivery={turn.owner} />
            {turn.owner.status !== "ready" && <div className="translation-retry" role="status">
              {inFlight.has(turn.id) ? "Translating…" : <><span>Translation unavailable.</span><button type="button"
                onClick={() => deliver(turn)}>Retry translation</button></>}
            </div>}
          </div>;
        })}
        {interrupted && !voice.busy && !voice.recording && <div className="translation-retry" role="status">
          <span>Recording needs to be captured again.</span>
          <button type="button" onClick={() => voice.start(interrupted)}>Record again</button>
        </div>}
      </div>
      {input("owner")}{controls("owner")}
    </section>
  </main>;
}
