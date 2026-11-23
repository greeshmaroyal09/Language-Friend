import { useEffect, useRef, useState } from "react";
import { WavRecorder } from "./audio";
import { stopSpeech } from "./speech";

export async function postChatForm(path: string, fields: Record<string, string | File>, signal: AbortSignal) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  const response = await fetch(path, { method: "POST", body, signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Request failed. Please try again.");
  return result;
}

export function useChatRequests() {
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(new Set<string>());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    const requests = pending.current;
    lifetime.current = controller;
    return () => {
      controller.abort();
      requests.clear();
      stopSpeech();
    };
  }, []);

  async function run(key: string, job: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current.has(key)) return;
    pending.current.add(key);
    setInFlight(new Set(pending.current));
    try {
      await job(signal);
    } finally {
      if (!signal.aborted) {
        pending.current.delete(key);
        setInFlight(new Set(pending.current));
      }
    }
  }

  return { run, inFlight };
}

export function useVoiceCapture<T extends { language: string }>(
  onPending: (capture: T) => void,
  onTranscript: (capture: T, text: string) => void,
) {
  const { run, inFlight } = useChatRequests();
  const active = useRef<{ recorder: WavRecorder; capture: T } | null>(null);
  const [recording, setRecording] = useState<T | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => () => { active.current?.recorder.dispose(); }, []);

  function start(capture: T) {
    void run("capture", async (signal) => {
      if (active.current) return;
      setError("");
      const recorder = new WavRecorder();
      active.current = { recorder, capture };
      try {
        await recorder.start();
        if (signal.aborted) recorder.dispose();
        else setRecording(capture);
      } catch (cause) {
        active.current = null;
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Microphone unavailable.");
      }
    });
  }

  function stop() {
    void run("capture", async (signal) => {
      const current = active.current;
      if (!current) return;
      setRecording(null);
      onPending(current.capture);
      setStatus("Preparing audio…");
      try {
        const audio = await current.recorder.stop();
        if (signal.aborted) return;
        setStatus("Transcribing…");
        const result = await postChatForm("/api/transcribe", {
          audio: new File([audio], "language-friend.wav", { type: "audio/wav" }),
          language: current.capture.language,
        }, signal);
        if (typeof result.transcript !== "string" || !result.transcript.trim()) throw new Error("Transcription returned no text.");
        if (!signal.aborted) onTranscript(current.capture, result.transcript.trim());
      } catch (cause) {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Transcription failed.");
      } finally {
        active.current = null;
        if (!signal.aborted) setStatus("");
      }
    });
  }

  return { start, stop, recording, busy: inFlight.has("capture"), status, error };
}
