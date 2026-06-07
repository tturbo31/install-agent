"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { ConversationWithLastMessage, Message } from "@/lib/types";
import ConversationSidebar from "@/components/ConversationSidebar";
import ChatHeader from "@/components/ChatHeader";
import ChatPanel from "@/components/ChatPanel";
import TrainingSimulator from "@/components/TrainingSimulator";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Play notification sound using Web Audio API (no external file needed)
function playNotification() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch { /* ignore audio errors */ }
}

type PlatformKey = "instagram" | "facebook" | "whatsapp";

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
};

export default function Dashboard() {
  const [conversations, setConversations] = useState<ConversationWithLastMessage[]>([]);
  const [selectedConv, setSelectedConv] = useState<ConversationWithLastMessage | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isTogglingMode, setIsTogglingMode] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<"inbox" | "simulator">("inbox");
  const selectedConvRef = useRef<string | null>(null);
  const [platformPaused, setPlatformPaused] = useState<Record<PlatformKey, boolean>>({
    instagram: false,
    facebook: false,
    whatsapp: false,
  });
  const [togglingPlatform, setTogglingPlatform] = useState<PlatformKey | null>(null);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setConversations(data);
  }, []);

  const loadPlatformSettings = useCallback(async () => {
    const res = await fetch("/api/platform-settings");
    if (!res.ok) return;
    const data: { platform: string; paused: boolean }[] = await res.json();
    const map: Record<PlatformKey, boolean> = { instagram: false, facebook: false, whatsapp: false };
    for (const row of data) {
      if (row.platform in map) map[row.platform as PlatformKey] = row.paused;
    }
    setPlatformPaused(map);
  }, []);

  async function handleTogglePlatform(platform: PlatformKey) {
    setTogglingPlatform(platform);
    const newPaused = !platformPaused[platform];
    const res = await fetch("/api/platform-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, paused: newPaused }),
    });
    if (res.ok) {
      setPlatformPaused(prev => ({ ...prev, [platform]: newPaused }));
    }
    setTogglingPlatform(null);
  }

  const loadMessages = useCallback(async (convId: string) => {
    const res = await fetch(`/api/conversations/${convId}/messages`);
    const data = await res.json();
    setMessages(data);
  }, []);

  useEffect(() => {
    loadConversations();
    loadPlatformSettings();
  }, [loadConversations, loadPlatformSettings]);

  useEffect(() => {
    if (selectedConv) {
      selectedConvRef.current = selectedConv.id;
      loadMessages(selectedConv.id);
      // Mark as read when opening
      setUnreadMap(prev => ({ ...prev, [selectedConv.id]: 0 }));
    }
  }, [selectedConv, loadMessages]);

  // Supabase Realtime — new messages trigger notification + unread count
  useEffect(() => {
    const channel = supabase
      .channel("realtime-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "instagram_messages" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const newMsg = payload.new as Message;

            // Add to messages if this conversation is open
            if (newMsg.conversation_id === selectedConvRef.current) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === newMsg.id)) return prev;
                return [...prev, newMsg];
              });
            }

            // If it's a client message in a different conversation → unread + sound
            if (newMsg.role === "user" && newMsg.conversation_id !== selectedConvRef.current) {
              playNotification();
              setUnreadMap(prev => ({
                ...prev,
                [newMsg.conversation_id]: (prev[newMsg.conversation_id] ?? 0) + 1,
              }));
            }

            loadConversations();
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "instagram_conversations" },
        () => { loadConversations(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadConversations]);

  async function handleSelectConversation(conv: ConversationWithLastMessage) {
    setSelectedConv(conv);
    setMessages([]);
    setUnreadMap(prev => ({ ...prev, [conv.id]: 0 }));
  }

  async function handleToggleMode() {
    if (!selectedConv) return;
    setIsTogglingMode(true);
    const newMode = selectedConv.mode === "agent" ? "human" : "agent";
    const res = await fetch(`/api/conversations/${selectedConv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode }),
    });
    if (res.ok) {
      const updated = await res.json();
      setSelectedConv(updated);
      setConversations(prev => prev.map(c => c.id === updated.id ? { ...c, mode: updated.mode } : c));
    }
    setIsTogglingMode(false);
  }

  async function handleResumeAgent() {
    if (!confirm("Reativar o agente em TODAS as conversas? Ele voltará a responder automaticamente.")) return;
    setIsResuming(true);
    const res = await fetch(`/api/resume?secret=${process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka"}`, { method: "POST" });
    const data = await res.json();
    setResumeMsg(`Agente reativado em ${data.resumed} conversas.`);
    await loadConversations();
    setIsResuming(false);
    setTimeout(() => setResumeMsg(null), 5000);
  }

  async function handleSendMessage(text: string) {
    if (!selectedConv) return;
    setIsSending(true);
    await fetch(`/api/conversations/${selectedConv.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setIsSending(false);
  }

  const totalUnread = Object.values(unreadMap).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      {/* Top bar — normal flow, never overlaps the conversation header below */}
      <header className="flex-shrink-0 h-16 z-30 bg-gray-900 border-b border-gray-800 px-5 flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 flex items-center justify-center font-black text-base shadow-lg shadow-violet-900/30">O</div>
          <div className="leading-tight hidden sm:block">
            <div className="font-bold text-sm tracking-tight">OzziFloors</div>
            <div className="text-[10px] text-gray-500 -mt-0.5">Painel de Vendas IA</div>
          </div>
        </div>

        {/* Platform status toggles (each pauses/reactivates the whole channel) */}
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto no-scrollbar">
          {(Object.keys(PLATFORM_LABELS) as PlatformKey[]).map((platform) => {
            const paused = platformPaused[platform];
            const isLoading = togglingPlatform === platform;
            return (
              <button
                key={platform}
                onClick={() => handleTogglePlatform(platform)}
                disabled={isLoading}
                title={paused ? `Ativar a IA no ${PLATFORM_LABELS[platform]}` : `Pausar a IA no ${PLATFORM_LABELS[platform]}`}
                className={`flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-full text-xs font-semibold border transition-colors disabled:opacity-50 whitespace-nowrap ${
                  paused
                    ? "bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/20"
                    : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20"
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${paused ? "bg-red-400" : "bg-emerald-400 animate-pulse"}`} />
                {PLATFORM_LABELS[platform]}
                <span className="text-[10px] opacity-70 font-bold">{isLoading ? "..." : paused ? "PAUSADO" : "ATIVO"}</span>
              </button>
            );
          })}
        </div>

        {/* Right: unread + resume all */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {totalUnread > 0 && (
            <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
              {totalUnread} nova{totalUnread > 1 ? "s" : ""}
            </span>
          )}
          {resumeMsg && <span className="text-emerald-400 text-xs font-semibold hidden md:inline">{resumeMsg}</span>}
          <button
            onClick={handleResumeAgent}
            disabled={isResuming}
            title="Reativar a IA em TODAS as conversas de uma vez"
            className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-100 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
          >
            <span className="text-sm">↻</span>
            {isResuming ? "Reativando..." : "Reativar todas"}
          </button>
        </div>
      </header>

      <div className="flex flex-1 w-full overflow-hidden">
        {activeTab === "simulator" ? (
          /* Simulator tab: full-width, no sidebar */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Tab bar inside the main area */}
            <div className="flex-shrink-0 flex border-b border-gray-800 bg-gray-900">
              <button
                onClick={() => setActiveTab("inbox")}
                className="flex items-center gap-2 px-5 py-3 text-sm font-medium text-gray-400 hover:text-white transition-colors border-b-2 border-transparent"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3-1-1z" />
                </svg>
                Inbox
                {totalUnread > 0 && (
                  <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">
                    {totalUnread}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab("simulator")}
                className="flex items-center gap-2 px-5 py-3 text-sm font-medium text-white transition-colors border-b-2 border-indigo-500"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.63 48.63 0 0112 20.904a48.63 48.63 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
                </svg>
                Simulador
              </button>
            </div>
            <TrainingSimulator />
          </div>
        ) : (
          /* Inbox tab: sidebar + chat panel */
          <>
            <div className="flex flex-col w-80 flex-shrink-0 border-r border-gray-800 min-h-0">
              {/* Tab bar above the sidebar */}
              <div className="flex border-b border-gray-800 bg-gray-900 flex-shrink-0">
                <button
                  onClick={() => setActiveTab("inbox")}
                  className="flex items-center gap-2 px-5 py-3 text-sm font-medium text-white transition-colors border-b-2 border-indigo-500"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3-1-1z" />
                  </svg>
                  Inbox
                  {totalUnread > 0 && (
                    <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">
                      {totalUnread}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab("simulator")}
                  className="flex items-center gap-2 px-5 py-3 text-sm font-medium text-gray-400 hover:text-white transition-colors border-b-2 border-transparent"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.63 48.63 0 0112 20.904a48.63 48.63 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
                  </svg>
                  Simulador
                </button>
              </div>
              <ConversationSidebar
                conversations={conversations}
                selectedId={selectedConv?.id ?? null}
                onSelect={handleSelectConversation}
                unreadMap={unreadMap}
              />
            </div>

            <main className="flex-1 flex flex-col overflow-hidden">
              {selectedConv ? (
                <>
                  <ChatHeader
                    conversation={selectedConv}
                    onToggleMode={handleToggleMode}
                    isTogglingMode={isTogglingMode}
                  />
                  <ChatPanel
                    conversation={selectedConv}
                    messages={messages}
                    onSendMessage={handleSendMessage}
                    isSending={isSending}
                  />
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <div className="text-5xl mb-4">💬</div>
                    <h2 className="text-gray-400 text-xl font-medium">
                      {totalUnread > 0
                        ? `${totalUnread} mensagem${totalUnread > 1 ? "s" : ""} nova${totalUnread > 1 ? "s" : ""} aguardando`
                        : "Selecione uma conversa"}
                    </h2>
                    <p className="text-gray-600 text-sm mt-2">
                      Responda pelo dashboard — o cliente recebe pelo Instagram e o agente aprende
                    </p>
                  </div>
                </div>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
