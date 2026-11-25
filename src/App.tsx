import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Header from "./components/Header";
import HumanChat from "./components/HumanChat";
import AIBotPlaceholder from "./components/AIBotPlaceholder";
import { SettingsProvider } from "./components/SettingsProvider";
import { ChatHistoryProvider, useChatHistory } from "./chatHistory";
import { useEffect, useState } from "react";
import { useAppUpdate, useOnlineStatus } from "./pwa";

function AIBotRoute() {
  const { activeConversation, ensureConversation } = useChatHistory();
  useEffect(() => {
    ensureConversation();
  }, [ensureConversation]);
  return activeConversation
    ? <AIBotPlaceholder key={activeConversation.id} conversation={activeConversation} />
    : null;
}

export default function App() {
  const [humanChatKey, setHumanChatKey] = useState(0);
  const online = useOnlineStatus();
  const updateAvailable = useAppUpdate();
  return (
    <SettingsProvider>
      <Router>
        <ChatHistoryProvider>
          <div className="app-shell">
            <Header onNewHumanChat={() => setHumanChatKey((key) => key + 1)} />
            {!online && <div className="app-offline" role="status">
              You’re offline. Recording, translation, AI Bot and audio playback need an internet connection.
            </div>}
            {online && updateAvailable && <div className="app-offline" role="status">
              A new version of Language Friend is ready.{" "}
              <button className="header-btn" type="button" onClick={() => window.location.reload()}>Reload app</button>
            </div>}
            <Routes>
              <Route path="/human" element={<HumanChat key={humanChatKey} />} />
              <Route path="/ai" element={<AIBotRoute />} />
              <Route path="/" element={<Navigate replace to="/human" />} />
            </Routes>
          </div>
        </ChatHistoryProvider>
      </Router>
    </SettingsProvider>
  );
}
