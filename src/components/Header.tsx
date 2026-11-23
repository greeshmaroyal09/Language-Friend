import { useNavigate } from "react-router-dom";
import { useSettings, type Theme } from "./SettingsProvider";
import { useState, useRef, useEffect } from "react";
import { CHAT_LANGUAGES, SPOKEN_LANGUAGES } from "../languages";
import { useChatHistory } from "../chatHistory";

export default function Header({ onNewHumanChat }: { onNewHumanChat: () => void }) {
  const navigate = useNavigate();
  const { conversations, startNewConversation, openConversation, activeConversation } = useChatHistory();
  const { spokenLanguage, setSpokenLanguage, chatLanguage, setChatLanguage, theme, setTheme } = useSettings();
  const [showNewChatMenu, setShowNewChatMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const newChatRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (newChatRef.current && !newChatRef.current.contains(event.target as Node)) {
        setShowNewChatMenu(false);
      }
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setShowSettings(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const startChat = (type: "ai" | "human") => {
    setShowNewChatMenu(false);
    if (type === "human") onNewHumanChat();
    else startNewConversation();
    navigate("/" + type);
  };

  return (
    <header className="app-header">
      {/* Top Left: New Chat */}
      <div className="relative-container" ref={newChatRef}>
        <button
          onClick={() => setShowNewChatMenu(!showNewChatMenu)}
          className="header-btn"
          aria-label="New Chat menu"
          aria-haspopup="true"
          aria-expanded={showNewChatMenu}
        >
          <span className="plus-icon">+</span> New Chat
        </button>

        {showNewChatMenu && (
          <div className="dropdown-panel left-panel">
            <button
              onClick={() => startChat("ai")}
              className="dropdown-item"
              aria-label="AI Bot"
            >
              <span className="menu-icon" role="img" aria-label="robot sticker">🤖</span>
              <span>AI Bot</span>
            </button>
            <button
              onClick={() => startChat("human")}
              className="dropdown-item"
              aria-label="Human Chat"
            >
              <span className="menu-icon" role="img" aria-label="human dialogue">👥</span>
              <span>Human Chat</span>
            </button>
          </div>
        )}
      </div>

      {/* App Name */}
      <h1 className="app-title">Language Friend</h1>

      {/* Top Right: Settings */}
      <div className="relative-container header-end" ref={settingsRef}>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="header-btn"
          aria-label="Open Settings"
          aria-haspopup="true"
          aria-expanded={showSettings}
        >
          Settings ⚙️
        </button>

        {showSettings && (
          <div className="dropdown-panel right-panel">
            <div className="settings-section">
              <span className="settings-label" id="history-label">History</span>
              {conversations.length === 0 ? <div className="empty-state">No saved AI Bot chats yet</div> :
                <ul className="chat-history" aria-labelledby="history-label">
                  {conversations.map((entry) => <li key={entry.id}>
                    <button type="button" className="dropdown-item" onClick={() => {
                      if (!openConversation(entry.id)) return;
                      setShowSettings(false);
                      navigate("/ai");
                    }}>
                      <span>{entry.title}</span>
                      <small>{new Date(entry.updatedAt).toLocaleString()}{activeConversation?.id === entry.id ? " · Last opened" : ""}</small>
                    </button>
                  </li>)}
                </ul>}
            </div>

            <div className="settings-section">
              <label htmlFor="my-lang-select" className="settings-label">
                My language
              </label>
              <select
                id="my-lang-select"
                value={spokenLanguage}
                onChange={(e) => setSpokenLanguage(e.target.value)}
                className="settings-select"
                aria-label="My language"
              >
                {SPOKEN_LANGUAGES.map((language) => (
                  <option key={language.value} value={language.value}>{language.label}</option>
                ))}
              </select>
            </div>

            <div className="settings-section">
              <label htmlFor="my-chat-lang-select" className="settings-label">My Chat Language</label>
              <select id="my-chat-lang-select" value={chatLanguage} onChange={(e) => setChatLanguage(e.target.value)} className="settings-select" aria-label="My Chat Language">
                {CHAT_LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
              </select>
            </div>

            <div className="settings-section">
              <label htmlFor="chat-theme-select" className="settings-label">
                Chat theme
              </label>
              <select
                id="chat-theme-select"
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
                className="settings-select"
                aria-label="Chat theme"
              >
                <option value="black-red">Black + Red</option>
                <option value="black-lavender">Black + Lavender</option>
                <option value="light">Light</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
