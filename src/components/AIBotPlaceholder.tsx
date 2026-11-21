import { useEffect, useRef, useState } from "react";
import { WavRecorder } from "../audio";
import { getChatLanguage, getSpokenLanguage } from "../languages";
import { isSpeechCancellation, playSpeech, stopSpeech } from "../speech";
import { useSettings } from "./SettingsProvider";

type BotHistoryMessage = { role: "user" | "bot"; text: string };
type ReplyRequest = { message: string; style: string; speechLanguage: string; history: BotHistoryMessage[] };
type ReplyState = { request: ReplyRequest; status: "replying" | "failed"; error?: string };
type BotMessage = { id: string; role: "user" | "bot"; text: string; speechText?: string; language?: string; reply?: ReplyState };
type BotStatus = "idle" | "recording" | "converting" | "transcribing" | "thinking";

const statusText: Record<BotStatus, string> = { idle: "", recording: "Listening… tap again when finished", converting: "Preparing audio…", transcribing: "Transcribing your message…", thinking: "AI Bot is replying…" };

function BotBubble({ message, fallbackLanguage, onRetryReply }: { message: BotMessage; fallbackLanguage: string; onRetryReply: (message: BotMessage) => void }) {
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const speak = async () => {
    if (loading) return; setLoading(true); setError("");
    try { await playSpeech(message.speechText ?? message.text, message.language ?? fallbackLanguage); }
    catch (cause) { if (!isSpeechCancellation(cause)) setError(cause instanceof Error ? cause.message : "Speech playback failed."); }
    finally { setLoading(false); }
  };
  return <div className={`ai-message ${message.role === "user" ? "ai-user-message" : "ai-bot-message"}`}>
    <small>{message.role === "user" ? "You" : "AI Bot"}</small>{message.text}
    {message.role === "bot" && <button className="speaker-btn ai-speaker-btn" type="button" disabled={loading} onClick={() => void speak()} aria-label={error ? `Retry audio: ${message.text}` : `Play audio: ${message.text}`}>{loading ? "Loading…" : error ? "Retry audio" : "🔊"}</button>}
    {message.role === "user" && message.reply && <div className="translation-retry" role="status"><span>{message.reply.status === "replying" ? "AI Bot is replying…" : message.reply.error || "AI Bot could not reply."}</span><button type="button" disabled={message.reply.status === "replying"} onClick={() => onRetryReply(message)}>{message.reply.status === "replying" ? "Replying…" : "Retry reply"}</button></div>}
    {error && <span className="voice-unavailable" role="status">{error}</span>}
  </div>;
}

export default function AIBotPlaceholder() {
  const { spokenLanguage, chatLanguage } = useSettings();
  const spoken = getSpokenLanguage(spokenLanguage); const chat = getChatLanguage(chatLanguage);
  const [status, setStatus] = useState<BotStatus>("idle"); const [error, setError] = useState("");
  const [messages, setMessages] = useState<BotMessage[]>([]); const recorder = useRef<WavRecorder | null>(null); const replying = useRef(new Set<string>());
  useEffect(() => () => { recorder.current?.dispose(); replying.current.clear(); stopSpeech(); }, []);

  const requestReply = async (messageId: string, request: ReplyRequest) => {
    if (replying.current.has(messageId)) return;
    replying.current.add(messageId); setError(""); setStatus("thinking");
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, reply: { request, status: "replying" } } : message));
    try {
      const replyBody = new FormData(); replyBody.append("message", request.message); replyBody.append("style", request.style); replyBody.append("history", JSON.stringify(request.history));
      const replyResponse = await fetch("/api/bot/reply", { method: "POST", body: replyBody }); const reply = await replyResponse.json().catch(() => ({}));
      if (!replyResponse.ok) throw new Error(reply.detail || "AI Bot could not reply. Retry reply.");
      if (!reply.reply?.trim()) throw new Error("AI Bot returned no reply. Retry reply.");
      setMessages((current) => {
        if (!current.some((message) => message.id === messageId)) return current;
        return [...current.map((message) => message.id === messageId ? { ...message, reply: undefined } : message), { id: crypto.randomUUID(), role: "bot", text: reply.reply, speechText: reply.speech_text || reply.reply, language: reply.speech_language || request.speechLanguage }];
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "AI Bot could not reply. Retry reply.";
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, reply: { request, status: "failed", error: detail } } : message));
    } finally { replying.current.delete(messageId); setStatus("idle"); }
  };

  const retryReply = (message: BotMessage) => { if (message.role === "user" && message.reply?.status === "failed") void requestReply(message.id, message.reply.request); };
  const start = async () => {
    setError("");
    try { const next = new WavRecorder(); await next.start(); recorder.current = next; setStatus("recording"); }
    catch (cause) { setStatus("idle"); setError(cause instanceof Error ? `Microphone unavailable: ${cause.message}` : "Microphone permission was denied. Allow access and try again."); }
  };
  const stop = async () => {
    const active = recorder.current; if (!active) return; recorder.current = null; setStatus("converting"); setError("");
    try {
      const audio = await active.stop(); setStatus("transcribing");
      const transcriptionBody = new FormData(); transcriptionBody.append("audio", audio, "language-friend-bot.wav"); transcriptionBody.append("language", spoken.tag);
      const transcriptionResponse = await fetch("/api/transcribe", { method: "POST", body: transcriptionBody }); const transcription = await transcriptionResponse.json().catch(() => ({}));
      if (!transcriptionResponse.ok) throw new Error(transcription.detail || "Speech transcription failed. Please try again.");
      const history = messages.slice(-12).map(({ role, text }) => ({ role, text })); const userMessage: BotMessage = { id: crypto.randomUUID(), role: "user", text: transcription.transcript };
      const request: ReplyRequest = { message: transcription.transcript, style: chat.value, speechLanguage: chat.tag, history };
      setMessages((current) => [...current, userMessage]); await requestReply(userMessage.id, request);
    } catch (cause) { setStatus("idle"); setError(cause instanceof Error ? cause.message : "The request failed. Please try again."); }
  };
  const busy = status !== "idle" && status !== "recording";
  return <main className="ai-chat-screen"><section className="ai-chat-card" aria-label="AI Bot conversation"><div className="ai-chat-heading"><span className="ai-icon" aria-hidden="true">🤖</span><div><h2>AI Bot</h2><p>Replies in {chat.label}</p></div></div>
    <div className="ai-messages" aria-live="polite">{messages.length === 0 && <p className="ai-empty">Tap the microphone and speak in {spoken.label}.</p>}{messages.map((message) => <BotBubble key={message.id} message={message} fallbackLanguage={chat.tag} onRetryReply={retryReply} />)}</div>
    {(status !== "idle" || error) && <div className="ai-status" role={error ? "alert" : "status"}>{error || statusText[status]}</div>}
    <button className="mic-button owner-mic ai-mic" disabled={busy} onClick={() => status === "recording" ? void stop() : void start()} aria-label={status === "recording" ? "Stop recording" : `Start recording in ${spoken.label}`}>🎙 <span>{status === "recording" ? "Stop listening" : `${spoken.label} mic`}</span></button>
  </section></main>;
}
