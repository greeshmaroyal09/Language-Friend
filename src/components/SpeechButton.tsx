import { useState } from "react";
import { isSpeechCancellation, playSpeech } from "../speech";

export function SpeechButton({ text, speechText, language }: { text: string; speechText: string; language: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function speak() {
    if (loading) return;
    setLoading(true);
    setError("");
    try { await playSpeech(speechText, language); }
    catch (cause) {
      if (!isSpeechCancellation(cause)) setError(cause instanceof Error ? cause.message : "Speech playback failed.");
    } finally { setLoading(false); }
  }
  return <>
    <button className="speaker-btn" type="button" disabled={loading} onClick={() => void speak()}
      aria-label={(error ? "Retry audio: " : "Play audio: ") + text}>
      {loading ? "Loading…" : error ? "Retry audio" : "🔊"}
    </button>
    {error && <span className="voice-unavailable" role="status">{error}</span>}
  </>;
}
