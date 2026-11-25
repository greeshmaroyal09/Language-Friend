import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIOSSafari() {
  const agent = navigator.userAgent;
  const appleMobile = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  return appleMobile && /Safari/.test(agent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(agent);
}

export function useInstallPrompt() {
  const safari = isIOSSafari();
  const [standalone, setStandalone] = useState(isStandalone);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const mode = window.matchMedia("(display-mode: standalone)");
    const onModeChange = () => setStandalone(isStandalone());
    const onPrompt = (event: Event) => {
      event.preventDefault();
      if (!safari && !isStandalone()) setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setStandalone(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    mode.addEventListener("change", onModeChange);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      mode.removeEventListener("change", onModeChange);
    };
  }, [safari]);

  return {
    canInstall: !standalone && prompt !== null,
    showSafariGuidance: !standalone && safari,
    install() {
      if (!prompt || standalone) return;
      setPrompt(null); // The browser prompt can only be used once.
      void prompt.prompt().catch(() => { /* The browser may no longer allow this prompt. */ });
    },
  };
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function useAppUpdate() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
    if (!entry) return;
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== "visible" || !navigator.onLine) return;
      checking = true;
      try {
        const response = await fetch("/index.html", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const latest = new DOMParser().parseFromString(await response.text(), "text/html")
          .querySelector('script[type="module"][src]')?.getAttribute("src");
        if (!controller.signal.aborted && latest && entry !== latest) setAvailable(true);
      } catch { /* Retry on the next foreground or online event. */ }
      finally { checking = false; }
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    window.addEventListener("online", check);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("online", check);
    };
  }, []);
  return available;
}

export function registerServiceWorker() {
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((error: unknown) => {
      console.warn("Language Friend could not register its offline page", error);
    });
  }
}
