import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CHAT_LANGUAGES, SPOKEN_LANGUAGES, migrateLegacyPreference } from "../languages";

export type Theme = "black-red" | "black-lavender" | "light";
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
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("lf_theme");
    return saved === "black-lavender" || saved === "light" ? saved : "black-red";
  });
  useEffect(() => { localStorage.setItem("lf_spoken_language", spokenLanguage); }, [spokenLanguage]);
  useEffect(() => { localStorage.setItem("lf_chat_language", chatLanguage); }, [chatLanguage]);
  useEffect(() => {
    localStorage.setItem("lf_theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return <SettingsContext.Provider value={{ spokenLanguage, setSpokenLanguage, chatLanguage, setChatLanguage, theme, setTheme }}>{children}</SettingsContext.Provider>;
};
// eslint-disable-next-line react-refresh/only-export-components
export const useSettings = () => { const context = useContext(SettingsContext); if (!context) throw new Error("useSettings must be used within SettingsProvider"); return context; };
