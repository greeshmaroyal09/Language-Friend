let activeAudio: HTMLAudioElement | null = null;
let activeUrl: string | null = null;
let activeController: AbortController | null = null;

export function stopSpeech() {
  activeController?.abort(); activeController = null;
  if (activeAudio) { activeAudio.pause(); activeAudio.removeAttribute("src"); activeAudio.load(); activeAudio = null; }
  if (activeUrl) { URL.revokeObjectURL(activeUrl); activeUrl = null; }
}

export async function playSpeech(text: string, language: string) {
  stopSpeech();
  const controller = new AbortController(); activeController = controller;
  try {
    const body = new FormData(); body.append("text", text); body.append("language", language);
    const response = await fetch("/api/speech", { method: "POST", body, signal: controller.signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || "Speech generation failed.");
    const audioBlob = await response.blob();
    if (!audioBlob.size) throw new Error("Gnani returned an empty audio response.");
    if (controller.signal.aborted || activeController !== controller) throw new DOMException("Audio request canceled.", "AbortError");
    const url = URL.createObjectURL(audioBlob); const audio = new Audio(url); activeAudio = audio; activeUrl = url;
    const release = () => {
      if (activeAudio === audio) { activeAudio = null; activeController = null; }
      if (activeUrl === url) { URL.revokeObjectURL(url); activeUrl = null; }
    };
    audio.addEventListener("ended", release, { once: true }); audio.addEventListener("error", release, { once: true });
    try { await audio.play(); } catch (cause) { release(); throw new Error(cause instanceof Error ? `Browser playback was blocked: ${cause.message}` : "Browser playback was blocked."); }
  } catch (cause) {
    if (activeController === controller) activeController = null;
    throw cause;
  }
}

export const isSpeechCancellation = (cause: unknown) => cause instanceof Error && cause.name === "AbortError";
