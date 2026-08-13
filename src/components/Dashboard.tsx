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
  facebook: "Messenger",
  whatsapp: "WhatsApp",
};

function PlatformIcon({ platform, className }: { platform: PlatformKey; className?: string }) {
  if (platform === "instagram") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
      </svg>
    );
  }
  if (platform === "facebook") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 0C5.24 0 0 4.952 0 11.64c0 3.499 1.434 6.522 3.769 8.61a.96.96 0 01.323.683l.065 2.135a.96.96 0 001.347.849l2.381-1.051a.96.96 0 01.641-.047 13.07 13.07 0 003.474.468c6.76 0 12-4.952 12-11.64C24 4.952 18.76 0 12 0zm7.207 8.957l-3.525 5.593a1.8 1.8 0 01-2.604.48l-2.804-2.103a.72.72 0 00-.868.002l-3.786 2.874c-.505.383-1.165-.221-.826-.759l3.525-5.593a1.8 1.8 0 012.604-.48l2.804 2.103a.72.72 0 00.868-.002l3.786-2.874c.505-.383 1.165.221.826.759z"/>
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}

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
  // Mobile shows either the list or the open chat — never both squeezed together
  const inChat = activeTab === "inbox" && selectedConv !== null;

  const platformToggles = (Object.keys(PLATFORM_LABELS) as PlatformKey[]).map((platform) => {
    const paused = platformPaused[platform];
    const isLoading = togglingPlatform === platform;
    return (
      <button
        key={platform}
        onClick={() => handleTogglePlatform(platform)}
        disabled={isLoading}
        title={paused ? `Ativar a IA no ${PLATFORM_LABELS[platform]}` : `Pausar a IA no ${PLATFORM_LABELS[platform]}`}
        className={`flex items-center gap-1.5 h-9 pl-2.5 pr-3 rounded-full text-xs font-semibold border transition-all duration-150 active:scale-95 disabled:opacity-50 whitespace-nowrap shrink-0 ${
          paused
            ? "bg-red-500/10 border-red-400/25 text-red-300 hover:bg-red-500/20"
            : "bg-emerald-500/10 border-emerald-400/25 text-emerald-300 hover:bg-emerald-500/20"
        }`}
      >
        <PlatformIcon platform={platform} className="w-3.5 h-3.5" />
        {PLATFORM_LABELS[platform]}
        <span className={`w-1.5 h-1.5 rounded-full ${paused ? "bg-red-400" : "bg-emerald-400 animate-pulse"}`} />
        <span className="text-[10px] font-bold tracking-wide opacity-80">
          {isLoading ? "..." : paused ? "OFF" : "ON"}
        </span>
      </button>
    );
  });

  return (
    <div className="relative flex flex-col h-dvh bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Ambient brand glow behind the header */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(147,51,234,0.10),transparent_70%)]"
      />

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="relative z-30 shrink-0 border-b border-white/[0.06] bg-zinc-950/80 backdrop-blur-md">
        <div className="h-14 lg:h-16 px-3 sm:px-4 lg:px-5 flex items-center justify-between gap-2 sm:gap-3">
          {/* Brand */}
          <div className="flex items-center gap-2.5 shrink-0 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 grid place-items-center font-black text-[15px] text-white shadow-lg shadow-fuchsia-950/50 shrink-0">
              O
            </div>
            <div className="leading-tight hidden md:block">
              <div className="font-bold text-sm tracking-tight text-white">Ozzi Floors</div>
              <div className="text-[11px] text-zinc-400">Central de Atendimento IA</div>
            </div>
          </div>

          {/* Inbox / Simulador — segmented control */}
          <nav className="flex items-center gap-0.5 rounded-full bg-zinc-900 border border-white/10 p-1 shrink-0">
            <button
              onClick={() => setActiveTab("inbox")}
              className={`flex items-center gap-1.5 h-8 px-3 sm:px-4 rounded-full text-xs font-semibold transition-colors ${
                activeTab === "inbox"
                  ? "bg-white text-zinc-950 shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3-1-1z" />
              </svg>
              Inbox
              {totalUnread > 0 && (
                <span className="bg-red-600 text-white text-[10px] font-bold min-w-[18px] h-[18px] px-1 rounded-full grid place-items-center leading-none">
                  {totalUnread}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("simulator")}
              className={`flex items-center gap-1.5 h-8 px-3 sm:px-4 rounded-full text-xs font-semibold transition-colors ${
                activeTab === "simulator"
                  ? "bg-white text-zinc-950 shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.63 48.63 0 0112 20.904a48.63 48.63 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
              </svg>
              Simulador
            </button>
          </nav>

          {/* Platform switches — inline on desktop only */}
          <div className="hidden lg:flex items-center gap-2 min-w-0">
            {platformToggles}
          </div>

          {/* Right: resume-all */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {resumeMsg && (
              <span className="hidden xl:inline text-emerald-300 text-xs font-semibold animate-fade-in">{resumeMsg}</span>
            )}
            <button
              onClick={handleResumeAgent}
              disabled={isResuming}
              title="Reativar a IA em TODAS as conversas de uma vez"
              className="flex items-center gap-1.5 h-9 px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-zinc-200 text-xs font-semibold transition-all duration-150 active:scale-95 disabled:opacity-50 whitespace-nowrap"
            >
              <svg className={`w-4 h-4 ${isResuming ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              <span className="hidden sm:inline">{isResuming ? "Reativando..." : "Reativar todas"}</span>
            </button>
          </div>
        </div>

        {/* Platform switches — own scrollable row on mobile, hidden inside an open chat */}
        <div className={`lg:hidden items-center gap-2 px-3 sm:px-4 pb-2.5 overflow-x-auto no-scrollbar ${inChat ? "hidden" : "flex"}`}>
          {platformToggles}
          {resumeMsg && (
            <span className="text-emerald-300 text-xs font-semibold whitespace-nowrap animate-fade-in">{resumeMsg}</span>
          )}
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-1 w-full min-h-0">
        {activeTab === "simulator" ? (
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <TrainingSimulator />
          </div>
        ) : (
          <>
            {/* Conversation list — full screen on mobile, fixed column on desktop */}
            <div
              className={`${inChat ? "hidden lg:flex" : "flex"} flex-col w-full min-w-0 lg:w-[350px] xl:w-[380px] lg:shrink-0 lg:border-r border-white/[0.06] min-h-0 bg-zinc-950`}
            >
              <ConversationSidebar
                conversations={conversations}
                selectedId={selectedConv?.id ?? null}
                onSelect={handleSelectConversation}
                unreadMap={unreadMap}
              />
            </div>

            {/* Chat — full screen on mobile when open, right pane on desktop */}
            <main className={`${inChat ? "flex" : "hidden lg:flex"} flex-1 flex-col min-w-0 min-h-0`}>
              {selectedConv ? (
                <>
                  <ChatHeader
                    conversation={selectedConv}
                    onToggleMode={handleToggleMode}
                    isTogglingMode={isTogglingMode}
                    onBack={() => setSelectedConv(null)}
                  />
                  <ChatPanel
                    conversation={selectedConv}
                    messages={messages}
                    onSendMessage={handleSendMessage}
                    isSending={isSending}
                  />
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center p-8">
                  <div className="text-center max-w-sm animate-fade-in">
                    <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/15 to-fuchsia-500/15 border border-white/10 grid place-items-center mb-5">
                      <svg className="w-8 h-8 text-fuchsia-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                      </svg>
                    </div>
                    <h2 className="text-white text-lg font-semibold tracking-tight">
                      {totalUnread > 0
                        ? `${totalUnread} mensagem${totalUnread > 1 ? "s" : ""} nova${totalUnread > 1 ? "s" : ""} aguardando`
                        : "Selecione uma conversa"}
                    </h2>
                    <p className="text-zinc-400 text-sm mt-2 leading-relaxed">
                      Acompanhe a IA atendendo em tempo real — responda pelo painel e o cliente recebe direto no canal dele.
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
