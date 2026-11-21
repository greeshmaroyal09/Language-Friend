import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CHAT_LANGUAGES, SPOKEN_LANGUAGES, migrateLegacyPreference } from "../languages";

export type Theme = "black-red" | "black-lavender";
type SettingsContextType = {
  spokenLanguage: string; setSpokenLanguage: (language: string) => void;
  chatLanguage: string; setChatLanguage: (language: string) => void;
  theme: Theme; setTheme: (theme: Theme) => void;
};
const SettingsContext = createContext<SettingsContextType | undefined>(undefined);
const legacy = migrateLegacyPreference(localStorage.getItem("lf_language"));
const validSaved = (key: string, values: { value: string }[], fallback: string) => { const saved = localStorage.getItem(key); return values.some(({ value }) => value === saved) ? saved! : fallback; };

export const SettingsProvider = ({ children }: { children: ReactNode }) => {
  const [spokenLanguage, setSpokenLanguage] = useState(() => validSaved("lf_spoken_language", SPOKEN_LANGUAGES, legacy.spoken));
  const [chatLanguage, setChatLanguage] = useState(() => validSaved("lf_chat_language", CHAT_LANGUAGES, legacy.chat));
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem("lf_theme") === "black-lavender" ? "black-lavender" : "black-red");
  useEffect(() => { localStorage.setItem("lf_spoken_language", spokenLanguage); }, [spokenLanguage]);
  useEffect(() => { localStorage.setItem("lf_chat_language", chatLanguage); }, [chatLanguage]);
  useEffect(() => {
    localStorage.setItem("lf_theme", theme); const root = document.documentElement;
    if (theme === "black-red") { root.style.setProperty("--bg", "#050506"); root.style.setProperty("--accent", "#ef3340"); root.style.setProperty("--accent-deep", "#4a101b"); root.style.setProperty("--accent-glow", "#ef334088"); }
    else { root.style.setProperty("--bg", "#0b0813"); root.style.setProperty("--accent", "#b388ff"); root.style.setProperty("--accent-deep", "#241838"); root.style.setProperty("--accent-glow", "#b388ff88"); }
  }, [theme]);
  return <SettingsContext.Provider value={{ spokenLanguage, setSpokenLanguage, chatLanguage, setChatLanguage, theme, setTheme }}>{children}</SettingsContext.Provider>;
};
// eslint-disable-next-line react-refresh/only-export-components
export const useSettings = () => { const context = useContext(SettingsContext); if (!context) throw new Error("useSettings must be used within SettingsProvider"); return context; };
