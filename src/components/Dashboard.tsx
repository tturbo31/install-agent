"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { ConversationWithLastMessage, Message } from "@/lib/types";
import { CHANNELS, CHANNEL_LABEL, type Channel, type ListTab } from "@/lib/channel";
import ChannelIcon from "@/components/ChannelIcon";
import ConversationSidebar from "@/components/ConversationSidebar";
import ChatHeader from "@/components/ChatHeader";
import ChatPanel from "@/components/ChatPanel";
import TrainingSimulator from "@/components/TrainingSimulator";

// Painel (04/11/2026, skill dashboard-design aplicada): superfícies planas com
// linhas-fio, um só acento (violeta) para seleção/ação/não lida, âmbar só para
// "IA pausada" e vermelho só para falha; sem gradiente, sem vidro. A barra do
// topo cabe em 375 px sem rolar de lado (os interruptores encolhem para ícone).

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

// Lista paginada (04/11/2026): a rota devolve uma página por aba. Antes o
// painel pedia TODAS as conversas de uma vez e o Supabase cortava em 1.000
// (de 15.374): tudo sem atividade desde 29/10 sumia da lista ("China lavoile").
const PAGE = 200;
const MAX_REFRESH = 500;
type ListResponse = {
  conversations: ConversationWithLastMessage[];
  hasMore: boolean;
  counts: Partial<Record<ListTab, number | null>>;
};

type Toast = { text: string; tone: "ok" | "error" };

export default function Dashboard() {
  // null = primeira carga ainda não chegou (a lista mostra esqueleto).
  const [conversations, setConversations] = useState<ConversationWithLastMessage[] | null>(null);
  const [listTab, setListTab] = useState<ListTab>("instagram");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<ListTab, number | null>>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [selectedConv, setSelectedConv] = useState<ConversationWithLastMessage | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isTogglingMode, setIsTogglingMode] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<"inbox" | "simulator">("inbox");
  const [live, setLive] = useState(false);
  const selectedConvRef = useRef<string | null>(null);
  const loadSeq = useRef(0);
  const listTabRef = useRef<ListTab>("instagram");
  const loadedCountRef = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [platformPaused, setPlatformPaused] = useState<Record<Channel, boolean>>({
    instagram: false,
    facebook: false,
    whatsapp: false,
  });
  const [togglingPlatform, setTogglingPlatform] = useState<Channel | null>(null);

  const showToast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), tone === "error" ? 9000 : 4500);
  }, []);

  // A conversa aberta acompanha o banco: toda vez que uma versão mais nova
  // chega (lista recarregada, tempo real, releitura), o cabeçalho e o aviso
  // "IA pausada" passam a refletir ela. Antes o painel guardava a versão do
  // momento do clique e mostrava "IA pausada" com a IA ativa no banco.
  const syncSelected = useCallback((fresh: Partial<ConversationWithLastMessage> & { id: string }) => {
    setSelectedConv((prev) => (prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
    setConversations((prev) => (prev ? prev.map((c) => (c.id === fresh.id ? { ...c, ...fresh } : c)) : prev));
  }, []);

  const fetchPage = useCallback(async (tab: ListTab, limit: number, before?: string): Promise<ListResponse> => {
    const qs = new URLSearchParams({ channel: tab, limit: String(limit) });
    if (before) qs.set("before", before);
    const res = await fetch(`/api/conversations?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ListResponse;
    return { conversations: Array.isArray(data.conversations) ? data.conversations : [], hasMore: !!data.hasMore, counts: data.counts ?? {} };
  }, []);

  // Recarrega o topo da aba atual mantendo as páginas já abertas (até 500).
  const loadConversations = useCallback(async () => {
    const n = ++loadSeq.current;
    const tab = listTabRef.current;
    try {
      const data = await fetchPage(tab, Math.min(Math.max(PAGE, loadedCountRef.current), MAX_REFRESH));
      if (n !== loadSeq.current || tab !== listTabRef.current) return; // uma carga mais nova já respondeu
      loadedCountRef.current = data.conversations.length;
      setConversations(data.conversations);
      setHasMore(data.hasMore);
      setCounts(data.counts);
      setListError(null);
      const sel = selectedConvRef.current;
      const fresh = sel ? data.conversations.find((c) => c.id === sel) : undefined;
      if (fresh) setSelectedConv((prev) => (prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
    } catch {
      if (n === loadSeq.current) setListError("Não deu para atualizar a lista.");
    }
  }, [fetchPage]);

  // Mensagens chegam em rajada (o cliente manda 3 bolhas, o bot responde):
  // uma recarga por rajada, não uma por mensagem.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { loadConversations(); }, 700);
  }, [loadConversations]);

  async function handleLoadMore() {
    const list = conversations ?? [];
    const last = list[list.length - 1];
    if (!last || loadingMore) return;
    const tab = listTabRef.current;
    setLoadingMore(true);
    try {
      const data = await fetchPage(tab, PAGE, last.updated_at);
      if (tab !== listTabRef.current) return;
      setConversations((prev) => {
        const seen = new Set((prev ?? []).map((c) => c.id));
        const merged = [...(prev ?? []), ...data.conversations.filter((c) => !seen.has(c.id))];
        loadedCountRef.current = merged.length;
        return merged;
      });
      setHasMore(data.hasMore);
      setCounts(data.counts);
    } catch {
      showToast("Não deu para carregar mais conversas. Tente de novo.", "error");
    } finally {
      setLoadingMore(false);
    }
  }

  function handleListTabChange(tab: ListTab) {
    if (tab === listTabRef.current) return;
    listTabRef.current = tab;
    loadedCountRef.current = 0;
    setListTab(tab);
    setConversations(null);
    setHasMore(false);
    loadConversations();
  }

  const loadPlatformSettings = useCallback(async () => {
    const res = await fetch("/api/platform-settings");
    if (!res.ok) return;
    const data: { platform: string; paused: boolean }[] = await res.json();
    const map: Record<Channel, boolean> = { instagram: false, facebook: false, whatsapp: false };
    for (const row of data) {
      if (row.platform in map) map[row.platform as Channel] = row.paused;
    }
    setPlatformPaused(map);
  }, []);

  // Interruptor do canal: o estado mostrado é o que o banco devolveu, e o dono
  // vê a confirmação (ou o erro). Antes uma falha não mostrava nada.
  async function handleTogglePlatform(platform: Channel) {
    setTogglingPlatform(platform);
    const newPaused = !platformPaused[platform];
    const label = CHANNEL_LABEL[platform];
    try {
      const res = await fetch("/api/platform-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, paused: newPaused }),
      });
      const data = (await res.json().catch(() => ({}))) as { paused?: boolean; error?: string };
      if (res.ok && typeof data.paused === "boolean") {
        setPlatformPaused((prev) => ({ ...prev, [platform]: data.paused as boolean }));
        showToast(data.paused ? `IA pausada no ${label} inteiro (confirmado)` : `IA ligada no ${label} (confirmado)`);
      } else {
        showToast(`Não consegui ${newPaused ? "pausar" : "ligar"} a IA no ${label}: ${data.error ?? `HTTP ${res.status}`}`, "error");
        await loadPlatformSettings();
      }
    } catch (err) {
      showToast(`Sem conexão: a IA no ${label} não mudou (${String(err).slice(0, 80)})`, "error");
    } finally {
      setTogglingPlatform(null);
    }
  }

  const loadMessages = useCallback(async (convId: string) => {
    const res = await fetch(`/api/conversations/${convId}/messages`);
    const data = await res.json();
    if (selectedConvRef.current === convId) setMessages(Array.isArray(data) ? data : []);
  }, []);

  // Relê a conversa no banco (modo da IA atual).
  const refreshSelected = useCallback(async (convId: string): Promise<ConversationWithLastMessage | null> => {
    try {
      const res = await fetch(`/api/conversations/${convId}`);
      if (!res.ok) return null;
      const fresh = (await res.json()) as ConversationWithLastMessage;
      if (fresh?.id) syncSelected(fresh);
      return fresh;
    } catch {
      return null;
    }
  }, [syncSelected]);

  useEffect(() => {
    loadConversations();
    loadPlatformSettings();
  }, [loadConversations, loadPlatformSettings]);

  const selectedId = selectedConv?.id ?? null;
  useEffect(() => {
    selectedConvRef.current = selectedId;
    if (selectedId) {
      loadMessages(selectedId);
      refreshSelected(selectedId);
      // Mark as read when opening
      setUnreadMap(prev => ({ ...prev, [selectedId]: 0 }));
    }
  }, [selectedId, loadMessages, refreshSelected]);

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

            scheduleRefresh();
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "instagram_conversations" },
        (payload) => {
          // A mudança de modo (webhook pausou porque o dono respondeu pelo
          // app, outro aparelho reativou) entra na hora na conversa aberta.
          const row = payload.new as Partial<ConversationWithLastMessage> | null;
          if (row && typeof row.id === "string" && (row.mode === "agent" || row.mode === "human")) {
            syncSelected({ id: row.id, mode: row.mode });
          }
          scheduleRefresh();
        }
      )
      .subscribe((status) => { setLive(status === "SUBSCRIBED"); });

    return () => { supabase.removeChannel(channel); };
  }, [scheduleRefresh, syncSelected]);

  // Sem tempo real o painel não fica cego: a cada 30s relê a lista e a
  // conversa aberta (o modo da IA pode ter mudado por outro caminho).
  useEffect(() => {
    if (live) return;
    const t = setInterval(() => {
      loadConversations();
      if (selectedConvRef.current) refreshSelected(selectedConvRef.current);
    }, 30000);
    return () => clearInterval(t);
  }, [live, loadConversations, refreshSelected]);

  async function handleSelectConversation(conv: ConversationWithLastMessage) {
    setSelectedConv(conv);
    setMessages([]);
    setUnreadMap(prev => ({ ...prev, [conv.id]: 0 }));
  }

  // Pausar / reativar UMA conversa. O alvo é o que o botão mostra ("Pausar IA"
  // → humano, "Reativar IA" → agente) e o estado final é o que o banco
  // confirmou. Se o banco já estava no alvo (a tela estava velha), o dono é
  // avisado em vez de o clique inverter o estado.
  async function handleToggleMode() {
    if (!selectedConv) return;
    const convId = selectedConv.id;
    const target = selectedConv.mode === "agent" ? "human" : "agent";
    setIsTogglingMode(true);
    try {
      const current = await refreshSelected(convId);
      if (current && current.mode === target) {
        showToast(target === "human" ? "Esta conversa JÁ estava com a IA pausada (a tela estava desatualizada)" : "Esta conversa JÁ estava com a IA ativa (a tela estava desatualizada)");
        return;
      }
      const res = await fetch(`/api/conversations/${convId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: target }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ConversationWithLastMessage> & { error?: string; conversation?: ConversationWithLastMessage };
      if (res.ok && data.id && data.mode === target) {
        syncSelected(data as ConversationWithLastMessage);
        showToast(target === "human" ? "IA pausada nesta conversa (confirmado no banco)" : "IA reativada nesta conversa (confirmado no banco)");
      } else {
        if (data.conversation?.id) syncSelected(data.conversation);
        else await refreshSelected(convId);
        showToast(`Não consegui ${target === "human" ? "pausar" : "reativar"} a IA: ${data.error ?? `HTTP ${res.status}`}`, "error");
      }
    } catch (err) {
      await refreshSelected(convId);
      showToast(`Sem conexão: o modo da IA não mudou (${String(err).slice(0, 80)})`, "error");
    } finally {
      setIsTogglingMode(false);
    }
  }

  async function handleResumeAgent() {
    const pausedNow = counts.paused;
    const howMany = typeof pausedNow === "number" ? `as ${pausedNow} conversas pausadas` : "TODAS as conversas pausadas";
    if (!confirm(`Reativar a IA em ${howMany}? Ela volta a responder sozinha em cada uma, inclusive nas que você pausou de propósito. Para ver quais são, abra a aba "Pausadas".`)) return;
    setIsResuming(true);
    try {
      const res = await fetch(`/api/resume?secret=${process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka"}`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { resumed?: number; error?: string };
      if (!res.ok) {
        showToast(`Não consegui reativar: ${data.error ?? `HTTP ${res.status}`}`, "error");
      } else {
        const n = Number(data.resumed ?? 0);
        showToast(`IA reativada em ${n} ${n === 1 ? "conversa" : "conversas"} (confirmado no banco)`);
      }
    } catch (err) {
      showToast(`Sem conexão: nada foi reativado (${String(err).slice(0, 80)})`, "error");
    } finally {
      await loadConversations();
      if (selectedConvRef.current) await refreshSelected(selectedConvRef.current);
      setIsResuming(false);
    }
  }

  // 02/11/2026: o painel ignorava o status do envio — o texto sumia da caixa,
  // nenhuma bolha aparecia e o dono ficava sem saber se o cliente recebeu
  // (caso real: Instagram fora da janela de 24h, erro 10 do Meta). Agora o
  // resultado volta para o ChatPanel, que mostra o erro e devolve o texto.
  async function handleSendMessage(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!selectedConv) return { ok: false, error: "Nenhuma conversa selecionada." };
    setIsSending(true);
    try {
      const res = await fetch(`/api/conversations/${selectedConv.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; delivered?: boolean };
      if (res.ok) return { ok: true };
      // Entregue mas não gravada: não é falha de envio — avisa, sem devolver o texto.
      if (data.delivered) {
        setMessages((prev) => [
          ...prev,
          { id: `local-${Date.now()}`, conversation_id: selectedConv.id, role: "assistant", content: text, created_at: new Date().toISOString() } as Message,
        ]);
        return { ok: true, error: data.error };
      }
      return { ok: false, error: data.error ?? `Falha no envio (HTTP ${res.status}).` };
    } catch (err) {
      return { ok: false, error: `Sem conexão com o servidor do painel: ${String(err).slice(0, 120)}` };
    } finally {
      setIsSending(false);
    }
  }

  const totalUnread = Object.values(unreadMap).reduce((a, b) => a + b, 0);
  // Mobile shows either the list or the open chat — never both squeezed together
  const inChat = activeTab === "inbox" && selectedConv !== null;

  const platformSwitches = CHANNELS.map((platform) => {
    const paused = platformPaused[platform];
    const isLoading = togglingPlatform === platform;
    const label = CHANNEL_LABEL[platform];
    return (
      <button
        key={platform}
        role="switch"
        aria-checked={!paused}
        aria-label={`IA no ${label}`}
        onClick={() => handleTogglePlatform(platform)}
        disabled={isLoading}
        title={paused ? `IA pausada no ${label} — clique para ligar` : `IA ligada no ${label} — clique para pausar`}
        className="flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-full border border-line bg-card hover:bg-soft text-[12px] font-medium text-ink-2 transition-colors disabled:opacity-50 min-w-0 shrink-0"
      >
        <ChannelIcon channel={platform} className="w-3.5 h-3.5 text-muted shrink-0" />
        <span className="hidden sm:inline truncate">{label}</span>
        <span
          aria-hidden
          className={`relative w-7 h-4 rounded-full shrink-0 transition-colors ${paused ? "bg-line-strong" : "bg-accent"} ${isLoading ? "animate-pulse" : ""}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full transition-transform ${
              paused ? "bg-muted" : "bg-page translate-x-3"
            }`}
          />
        </span>
      </button>
    );
  });

  const resumeButton = (
    <button
      onClick={handleResumeAgent}
      disabled={isResuming}
      aria-label="Reativar a IA em todas as conversas"
      title="Reativar a IA em todas as conversas pausadas de uma vez"
      className="flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-full border border-line bg-card hover:bg-soft text-ink-2 text-[12px] font-medium transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
    >
      <svg className={`w-3.5 h-3.5 ${isResuming ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
      </svg>
      <span className="hidden sm:inline">{isResuming ? "Reativando…" : "Reativar todas"}</span>
    </button>
  );

  const liveDot = (
    <span
      title={live ? "Tempo real conectado: mensagens novas aparecem na hora" : "Sem tempo real agora — reconectando"}
      className="flex items-center gap-1.5 text-[12px] text-muted tabular-nums shrink-0"
    >
      <span className={`w-2 h-2 rounded-full ${live ? "bg-up animate-breathe" : "bg-down"}`} />
      <span className="hidden md:inline">{live ? "ao vivo" : "offline"}</span>
    </span>
  );

  return (
    <div className="relative flex flex-col h-dvh bg-page text-ink overflow-hidden">
      {/* ── Barra do topo ───────────────────────────────────────────────── */}
      <header className="relative z-30 shrink-0 border-b border-line bg-page">
        <div className="h-14 px-3 sm:px-4 flex items-center gap-2 sm:gap-3">
          {/* Marca — quieta: o olho deve cair na lista, não no logo */}
          <div className="flex items-center gap-2 shrink-0 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-soft ring-1 ring-inset ring-line grid place-items-center text-ink font-semibold text-[13px] shrink-0">
              O
            </div>
            <div className="leading-tight hidden md:block">
              <div className="font-semibold text-[13px] text-ink">Ozzi Floors</div>
              <div className="text-[11px] text-muted">Painel IA</div>
            </div>
          </div>

          {/* Inbox / Simulador — controle segmentado */}
          <nav aria-label="Seções" className="flex items-center gap-0.5 rounded-full bg-soft p-0.5 shrink-0">
            <button
              onClick={() => setActiveTab("inbox")}
              aria-current={activeTab === "inbox" ? "page" : undefined}
              className={`flex items-center gap-1.5 h-7 px-3 rounded-full text-[12px] font-medium transition-colors ${
                activeTab === "inbox" ? "bg-ink text-page" : "text-ink-2 hover:text-ink"
              }`}
            >
              Inbox
              {totalUnread > 0 && (
                <span className={`text-[10px] font-semibold min-w-4 h-4 px-1 rounded-full grid place-items-center leading-none tabular-nums ${
                  activeTab === "inbox" ? "bg-accent text-on-accent" : "bg-accent text-on-accent"
                }`}>
                  {totalUnread}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("simulator")}
              aria-current={activeTab === "simulator" ? "page" : undefined}
              className={`flex items-center gap-1.5 h-7 px-3 rounded-full text-[12px] font-medium transition-colors ${
                activeTab === "simulator" ? "bg-ink text-page" : "text-ink-2 hover:text-ink"
              }`}
            >
              Simulador
            </button>
          </nav>

          <div className="flex-1" />

          {/* Interruptores por canal — na mesma linha a partir de lg */}
          <div className="hidden lg:flex items-center gap-1.5">{platformSwitches}</div>

          {liveDot}
          {resumeButton}
        </div>

        {/* Abaixo de lg: interruptores em linha própria (cabem em 375 px, sem rolar); somem dentro de um chat aberto */}
        <div className={`lg:hidden items-center gap-1.5 px-3 sm:px-4 pb-2 ${inChat ? "hidden" : "flex"}`}>
          {platformSwitches}
        </div>
      </header>

      {/* ── Corpo ──────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-1 w-full min-h-0">
        {activeTab === "simulator" ? (
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <TrainingSimulator />
          </div>
        ) : (
          <>
            {/* Lista — tela cheia no celular, coluna fixa no desktop */}
            <div
              className={`${inChat ? "hidden lg:flex" : "flex"} flex-col w-full min-w-0 lg:w-[350px] xl:w-[390px] lg:shrink-0 lg:border-r border-line min-h-0`}
            >
              <ConversationSidebar
                conversations={conversations}
                listError={listError}
                onRetry={loadConversations}
                selectedId={selectedConv?.id ?? null}
                onSelect={handleSelectConversation}
                unreadMap={unreadMap}
                tab={listTab}
                onTabChange={handleListTabChange}
                counts={counts}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={handleLoadMore}
              />
            </div>

            {/* Chat — tela cheia no celular quando aberto, painel direito no desktop */}
            <main className={`${inChat ? "flex" : "hidden lg:flex"} flex-1 flex-col min-w-0 min-h-0 bg-page`}>
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
                  <div className="text-center max-w-xs">
                    <div className="mx-auto w-12 h-12 rounded-2xl bg-soft ring-1 ring-inset ring-line grid place-items-center text-muted mb-4">
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                      </svg>
                    </div>
                    <h2 className="text-ink text-[15px] font-semibold tracking-tight tabular-nums">
                      {totalUnread > 0
                        ? `${totalUnread} ${totalUnread === 1 ? "mensagem nova" : "mensagens novas"}`
                        : "Selecione uma conversa"}
                    </h2>
                    <p className="text-muted text-[13px] mt-1.5 leading-relaxed">
                      {totalUnread > 0 ? "Abra a conversa na lista para responder." : "Busque pelo nome, telefone ou endereço na lista."}
                    </p>
                  </div>
                </div>
              )}
            </main>
          </>
        )}
      </div>

      {toast && (
        <div
          role={toast.tone === "error" ? "alert" : "status"}
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 rounded-xl text-white text-[13px] font-medium px-4 py-2.5 shadow-pop animate-fade-in w-max max-w-[calc(100vw-2rem)] text-center ${
            toast.tone === "error" ? "bg-down" : "bg-tip"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
