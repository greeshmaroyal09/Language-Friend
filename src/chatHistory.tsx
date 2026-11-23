import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type StoredConversation = {
  id: string;
  mode: "ai";
  title: string;
  createdAt: string;
  updatedAt: string;
  data: unknown;
  hasTurns: boolean;
};

type HistoryStore = {
  version: 1;
  active: { ai?: string };
  conversations: StoredConversation[];
};

type ChatHistoryContextType = {
  conversations: StoredConversation[];
  activeConversation: StoredConversation | undefined;
  ensureConversation: () => StoredConversation;
  startNewConversation: () => StoredConversation;
  openConversation: (id: string) => StoredConversation | undefined;
  updateConversation: <T>(id: string, update: (data: T) => { data: T; title?: string; hasTurns?: boolean }) => void;
};

const STORAGE_KEY = "language-friend.chat-history.v1";
const ChatHistoryContext = createContext<ChatHistoryContextType | undefined>(undefined);

function emptyStore(): HistoryStore {
  return { version: 1, active: {}, conversations: [] };
}

function readStore(): HistoryStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<HistoryStore> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.conversations) || !parsed.active || typeof parsed.active !== "object") return emptyStore();
    const conversations = parsed.conversations.filter((conversation) => {
      if (!conversation || typeof conversation.id !== "string" ||
          conversation.mode !== "ai" ||
          typeof conversation.title !== "string" || typeof conversation.createdAt !== "string" ||
          typeof conversation.updatedAt !== "string") return false;
      const data = conversation.data as { turns?: unknown } | null;
      return Array.isArray(data?.turns);
    });
    const active = typeof parsed.active.ai === "string" ? { ai: parsed.active.ai } : {};
    return { version: 1, active, conversations };
  } catch {
    return emptyStore();
  }
}

function persist(store: HistoryStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // History is a convenience feature. A full or unavailable local store must not break chat.
  }
}

function createConversation(): StoredConversation {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), mode: "ai", title: "AI Bot", createdAt: now, updatedAt: now, data: { turns: [] }, hasTurns: false };
}

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<HistoryStore>(readStore);
  const storeRef = useRef(store);

  const commit = useCallback((next: HistoryStore) => {
    storeRef.current = next;
    persist(next);
    setStore(next);
  }, []);

  const startNewConversation = useCallback(() => {
    const conversation = createConversation();
    const current = storeRef.current;
    const next: HistoryStore = {
      version: 1,
      active: { ai: conversation.id },
      conversations: [conversation, ...current.conversations.filter((entry) => entry.id !== current.active.ai || entry.hasTurns)],
    };
    commit(next);
    return conversation;
  }, [commit]);

  const ensureConversation = useCallback(() => {
    const { active, conversations } = storeRef.current;
    return conversations.find((entry) => entry.id === active.ai) ?? startNewConversation();
  }, [startNewConversation]);

  const openConversation = useCallback((id: string) => {
    const current = storeRef.current;
    const conversation = current.conversations.find((entry) => entry.id === id);
    if (!conversation) return undefined;
    commit({ ...current, active: { ai: id } });
    return conversation;
  }, [commit]);

  const updateConversation = useCallback(<T,>(id: string, update: (data: T) => { data: T; title?: string; hasTurns?: boolean }) => {
    const current = storeRef.current;
    const existing = current.conversations.find((conversation) => conversation.id === id);
    if (!existing) return;
    const updated = { ...existing, ...update(existing.data as T), updatedAt: new Date().toISOString() };
    const next: HistoryStore = { ...current, conversations: current.conversations.map((conversation) => conversation.id === id ? updated : conversation) };
    commit(next);
  }, [commit]);

  const value = useMemo(() => ({
    conversations: store.conversations.filter((entry) => entry.hasTurns).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    activeConversation: store.conversations.find((entry) => entry.id === store.active.ai),
    ensureConversation,
    startNewConversation,
    openConversation,
    updateConversation,
  }), [ensureConversation, openConversation, updateConversation, startNewConversation, store]);

  return <ChatHistoryContext.Provider value={value}>{children}</ChatHistoryContext.Provider>;
}

// oxlint-disable-next-line react/only-export-components
export function useChatHistory() {
  const context = useContext(ChatHistoryContext);
  if (!context) throw new Error("useChatHistory must be used within ChatHistoryProvider");
  return context;
}
