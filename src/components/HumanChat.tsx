import { useEffect, useRef, useState } from "react";
import { useSettings } from "./SettingsProvider";
import { WavRecorder } from "../audio";
import { PARTNER_LANGUAGES, getChatLanguage, getSpokenLanguage, type SpokenLanguage } from "../languages";
import { isSpeechCancellation, playSpeech, stopSpeech } from "../speech";

type Side = "owner" | "other";
type TranslationLanguage = { value: string; tag: string };
type TranslationRequest = {
  message: string;
  sourceLanguage: string;
  sourceStyle: string;
  targetLanguage: string;
  targetStyle: string;
  targetLabel: string;
  targetSide: Side;
};
type TranslationState = { request: TranslationRequest; status: "translating" | "failed"; error?: string };
type Message = { id: string; side: Side; text: string; language: string; speechText?: string; label?: string; translation?: TranslationState };

function Bubble({ message, onRetryTranslation }: { message: Message; onRetryTranslation: (message: Message) => void }) {
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const speak = async () => {
    if (loading) return; setLoading(true); setError("");
    try { await playSpeech(message.speechText ?? message.text, message.language); }
    catch (cause) { if (!isSpeechCancellation(cause)) setError(cause instanceof Error ? cause.message : "Speech playback failed."); }
    finally { setLoading(false); }
  };
  const translation = message.translation;
  return <div className={`chat-bubble ${message.side === "owner" ? "owner-bubble" : "other-bubble"}`}>
    <span>{message.label && <small className="message-label">{message.label}</small>}{message.text}</span>
    <button className="speaker-btn" type="button" disabled={loading} onClick={() => void speak()} aria-label={error ? `Retry audio: ${message.text}` : `Play audio: ${message.text}`}>{loading ? "Loading…" : error ? "Retry audio" : "🔊"}</button>
    {translation && <div className="translation-retry" role="status">
      <span>{translation.status === "translating" ? "Translating…" : translation.error || "Translation unavailable."}</span>
      <button type="button" disabled={translation.status === "translating"} onClick={() => onRetryTranslation(message)}>{translation.status === "translating" ? "Translating…" : "Retry translation"}</button>
    </div>}
    {error && <span className="voice-unavailable" role="status">{error}</span>}
  </div>;
}

export default function HumanChat() {
  const { spokenLanguage, chatLanguage } = useSettings(); const spoken = getSpokenLanguage(spokenLanguage); const chat = getChatLanguage(chatLanguage);
  const [partner, setPartner] = useState<SpokenLanguage | null>(null); const [open, setOpen] = useState(false); const [recording, setRecording] = useState<Side | null>(null);
  const [status, setStatus] = useState(""); const [error, setError] = useState(""); const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState<Side | null>(null); const [draft, setDraft] = useState(""); const recorder = useRef<WavRecorder | null>(null); const menu = useRef<HTMLDivElement>(null); const translating = useRef(new Set<string>());
  useEffect(() => { const close = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) setOpen(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);
  useEffect(() => () => { recorder.current?.dispose(); translating.current.clear(); stopSpeech(); }, []);
  const translationRequest = (message: string, source: TranslationLanguage, target: TranslationLanguage, speaker: Side): TranslationRequest => ({ message, sourceLanguage: source.tag, sourceStyle: source.value, targetLanguage: target.tag, targetStyle: target.value, targetLabel: target.value, targetSide: speaker === "owner" ? "other" : "owner" });
  const translate = async (messageId: string, request: TranslationRequest) => {
    if (translating.current.has(messageId)) return;
    translating.current.add(messageId); setStatus("Translating…"); setError("");
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, translation: { request, status: "translating" } } : message));
    try {
      const body = new FormData(); body.append("message", request.message); body.append("source_language", request.sourceLanguage); body.append("source_style", request.sourceStyle); body.append("target_language", request.targetLanguage); body.append("target_style", request.targetStyle);
      const response = await fetch("/api/conversations/text", { method: "POST", body }); const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Message translation failed.");
      const translated = data.translation as string; const speechText = (data.speech_text as string | undefined) || translated;
      if (!translated?.trim()) throw new Error("Message translation returned no text.");
      setMessages((current) => {
        if (!current.some((message) => message.id === messageId)) return current;
        return [...current.map((message) => message.id === messageId ? { ...message, translation: undefined } : message), { id: crypto.randomUUID(), side: request.targetSide, text: translated, speechText, language: request.targetLanguage, label: request.targetLabel }];
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Message translation failed.";
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, translation: { request, status: "failed", error: detail } } : message));
    } finally {
      translating.current.delete(messageId); setStatus("");
    }
  };
  const retryTranslation = (message: Message) => { if (message.translation?.status === "failed") void translate(message.id, message.translation.request); };
  const submitAudio = async (speaker: Side, blob: Blob) => {
    if (!partner) return; const source = speaker === "owner" ? spoken : partner; const target = speaker === "owner" ? partner : chat;
    setStatus("Transcribing…");
    try {
      const body = new FormData(); body.append("audio", blob, "language-friend-recording.wav"); body.append("language", source.tag); const response = await fetch("/api/transcribe", { method: "POST", body }); const transcription = await response.json().catch(() => ({})); if (!response.ok) throw new Error(transcription.detail || "Transcription failed.");
      const transcript = transcription.transcript as string; const messageId = crypto.randomUUID(); const request = translationRequest(transcript, source, target, speaker);
      setMessages((current) => [...current, { id: messageId, side: speaker, text: transcript, language: source.tag, label: `${source.value} transcript` }]);
      await translate(messageId, request);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Conversation request failed."); } finally { setStatus(""); setRecording(null); }
  };
  const stop = async (speaker: Side) => { const active = recorder.current; if (!active) return; recorder.current = null; setStatus("Preparing audio…"); try { await submitAudio(speaker, await active.stop()); } catch (cause) { setRecording(null); setStatus(""); setError(cause instanceof Error ? `Audio conversion failed: ${cause.message}` : "Audio conversion failed. Please record again."); } };
  const toggleRecording = async (speaker: Side) => { setError(""); if (recording) { if (recording === speaker) void stop(speaker); return; } if (!partner) return; const source = speaker === "owner" ? spoken : partner; try { const next = new WavRecorder(); await next.start(); recorder.current = next; setRecording(speaker); setStatus(`Listening in ${source.value}…`); } catch (cause) { setError(cause instanceof Error ? cause.message : "Microphone permission was denied or is unavailable."); } };
  const submitText = async (speaker: Side) => {
    const text = draft.trim(); if (!text || !partner) return; const source = speaker === "owner" ? chat : partner; const target = speaker === "owner" ? partner : chat; const messageId = crypto.randomUUID(); const request = translationRequest(text, source, target, speaker);
    setMessages((current) => [...current, { id: messageId, side: speaker, text, language: source.tag, label: source.value }]); setDraft(""); setTyping(null);
    await translate(messageId, request);
  };
  const input = (side: Side) => typing === side && <form className="text-entry" onSubmit={(event) => { event.preventDefault(); void submitText(side); }}><input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus aria-label={`${side === "owner" ? "Your" : "Other person's"} message`} placeholder={`Type in ${side === "owner" ? chat.label : partner?.value ?? "their language"}`} /><button type="submit" disabled={!draft.trim()}>Send</button></form>;
  const controls = (side: Side) => <div className="chat-controls"><button className={`mic-button ${side === "owner" ? "owner-mic" : "other-mic"}`} disabled={!partner || (recording !== null && recording !== side)} onClick={() => recording === side ? void stop(side) : void toggleRecording(side)} aria-label={recording === side ? "Stop recording" : `Start recording in ${side === "owner" ? spoken.value : partner?.value ?? "the selected language"}`}>🎙 <span>{recording === side ? "Stop listening" : `${side === "owner" ? spoken.value : partner?.value ?? "Other person"} mic`}</span></button><button className="keyboard-button" disabled={!partner || recording !== null} onClick={() => { setTyping((current) => current === side ? null : side); setDraft(""); }} aria-label={`Type ${side === "owner" ? "your" : "the other person's"} message`}>⌨</button></div>;
  const owner = messages.filter((item) => item.side === "owner"); const other = messages.filter((item) => item.side === "other");
  return <main className="human-chat-container"><div className="diagonal-backdrop" aria-hidden="true"><div className="diagonal-other-area" /><div className="diagonal-owner-area" /></div>{(status || error) && <div className="voice-notice" role={error ? "alert" : "status"}>{error || status}</div>}
    <section className="conversation-area other-person-area" aria-label="Other person's conversation area">{controls("other")}{input("other")}<div className="bubbles-container other-bubbles">{other.map((message) => <Bubble key={message.id} message={message} onRetryTranslation={retryTranslation} />)}</div></section>
    <div className="center-lang-wrapper" ref={menu}><button className="lang-control" onClick={() => setOpen((value) => !value)} aria-label="Choose the other person's language" aria-haspopup="listbox" aria-expanded={open}><span>LANG{partner ? ` · ${partner.nativeLabel}` : ""}</span><svg className="lang-chevron" viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1.5 5 5 5-5" /></svg></button>{open && <ul className="lang-dropdown-menu" role="listbox" aria-label="Other person's language">{PARTNER_LANGUAGES.map((language) => <li className="lang-menu-item" key={language.value}><button onClick={() => { setPartner(language); setOpen(false); setError(""); }} role="option" aria-selected={partner?.value === language.value}>{language.nativeLabel}</button></li>)}</ul>}</div>
    <section className="conversation-area owner-area" aria-label="Your conversation area"><div className="bubbles-container owner-bubbles">{owner.map((message) => <Bubble key={message.id} message={message} onRetryTranslation={retryTranslation} />)}</div>{input("owner")}{controls("owner")}</section>
  </main>;
}
