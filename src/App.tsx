import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Header from "./components/Header";
import HumanChat from "./components/HumanChat";
import AIBotPlaceholder from "./components/AIBotPlaceholder";
import { SettingsProvider } from "./components/SettingsProvider";

export default function App() {
  return (
    <SettingsProvider>
      <Router>
        <div className="app-shell">
        <Header />
        <Routes>
          <Route path="/human" element={<HumanChat />} />
          <Route path="/ai" element={<AIBotPlaceholder />} />
          <Route path="/" element={<Navigate replace to="/human" />} />
        </Routes>
        </div>
      </Router>
    </SettingsProvider>
  );
}
