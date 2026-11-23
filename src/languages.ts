export type LocaleCode = "en-IN" | "te-IN" | "hi-IN" | "kn-IN" | "ta-IN";
export type SpokenLanguage = { value: string; label: string; nativeLabel: string; tag: LocaleCode };
export type ChatLanguage = { value: string; label: string; tag: LocaleCode };

export const SPOKEN_LANGUAGES: SpokenLanguage[] = [
  { value: "Telugu", label: "Telugu", nativeLabel: "తెలుగు", tag: "te-IN" },
  { value: "Hindi", label: "Hindi", nativeLabel: "हिन्दी", tag: "hi-IN" },
  { value: "English", label: "English", nativeLabel: "English", tag: "en-IN" },
  { value: "Kannada", label: "Kannada", nativeLabel: "ಕನ್ನಡ", tag: "kn-IN" },
  { value: "Tamil", label: "Tamil", nativeLabel: "தமிழ்", tag: "ta-IN" },
];

export const CHAT_LANGUAGES: ChatLanguage[] = [
  { value: "Telugu", label: "Telugu", tag: "te-IN" }, { value: "Hindi", label: "Hindi", tag: "hi-IN" },
  { value: "Kannada", label: "Kannada", tag: "kn-IN" }, { value: "Tamil", label: "Tamil", tag: "ta-IN" },
  { value: "English", label: "English", tag: "en-IN" }, { value: "Tenglish", label: "Tenglish", tag: "te-IN" },
  { value: "Hinglish", label: "Hinglish", tag: "hi-IN" }, { value: "Kanglish", label: "Kanglish", tag: "kn-IN" },
  { value: "Tanglish", label: "Tanglish", tag: "ta-IN" },
];

export const PARTNER_LANGUAGES = ["English", "Telugu", "Kannada", "Tamil", "Hindi"].map((value) => SPOKEN_LANGUAGES.find((language) => language.value === value)!);
export const getSpokenLanguage = (value: string) => SPOKEN_LANGUAGES.find((language) => language.value === value) ?? SPOKEN_LANGUAGES[0];
export const getChatLanguage = (value: string) => CHAT_LANGUAGES.find((language) => language.value === value) ?? CHAT_LANGUAGES[5];

const indicScripts = [
  { script: /\p{Script=Telugu}/u, native: "Telugu", roman: "Tenglish" },
  { script: /\p{Script=Devanagari}/u, native: "Hindi", roman: "Hinglish" },
  { script: /\p{Script=Kannada}/u, native: "Kannada", roman: "Kanglish" },
  { script: /\p{Script=Tamil}/u, native: "Tamil", roman: "Tanglish" },
];

export const isRomanStyle = (value: string) => indicScripts.some(({ roman }) => roman === value);

export function typedLanguage(text: string, preferred: ChatLanguage): ChatLanguage {
  const expected = indicScripts.find(({ native, roman }) => preferred.value === native || preferred.value === roman);
  const actual = expected?.script.test(text) ? expected : indicScripts.find(({ script }) => script.test(text));
  if (actual) return getChatLanguage(actual.native);
  if (expected && /[a-z]/i.test(text)) return getChatLanguage(expected.roman);
  return preferred;
}

export function migrateLegacyPreference(value: string | null) {
  const chat = CHAT_LANGUAGES.some((language) => language.value === value) ? value! : "Tenglish";
  const spokenMap: Record<string, string> = { Tenglish: "Telugu", Hinglish: "Hindi", Kanglish: "Kannada", Tanglish: "Tamil" };
  const spoken = spokenMap[chat] ?? (SPOKEN_LANGUAGES.some((language) => language.value === chat) ? chat : "Telugu");
  return { spoken, chat };
}
