"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import { ConversationWithLastMessage, Message } from "@/lib/types";

interface Props {
  conversation: ConversationWithLastMessage;
  messages: Message[];
  onSendMessage: (text: string) => Promise<void>;
  isSending: boolean;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInitials(name: string | null, username: string | null): string {
  const str = name || username || "?";
  return str
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function ChatPanel({ conversation, messages, onSendMessage, isSending }: Props) {
  const [input, setInput] = useState("");
  // Scroll the MESSAGES container directly — never scrollIntoView, which would
  // also scroll ancestor elements (and the page), hiding the headers/buttons.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  function jumpToBottom(smooth = false) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(nearBottom);
  }

  // Switching conversations: jump straight to the latest message.
  useEffect(() => {
    jumpToBottom(false);
    setAtBottom(true);
  }, [conversation.id]);

  // New messages: follow only if the owner is already reading the bottom,
  // so scrolling up to read history is never yanked back down.
  useEffect(() => {
    if (atBottom) jumpToBottom(false);
  }, [messages, atBottom]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    await onSendMessage(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Messages — isolated scroll area; headers above stay fixed */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto px-3 sm:px-6 py-5 space-y-4"
        >
        {messages.length === 0 && (
          <div className="text-center text-zinc-500 text-sm mt-10">
            Nenhuma mensagem ainda
          </div>
        )}

        {messages.map((msg, i) => {
          const isUser = msg.role === "user";
          // Strip internal context injections before displaying
          const displayContent = msg.content
            .replace(/\[Floor plan analysis:[\s\S]*?\]/g, "[floor plan image]")
            .replace(/\[SYSTEM:[\s\S]*?\]/g, "")
            .replace(/\[Voice:[\s\S]*?\]/g, "[voice message]")
            .trim() || (isUser ? "[media]" : "");

          // The client message that immediately preceded this AI reply — used as
          // the "PERGUNTA" when the owner corrects the response.
          let precedingUserText = "";
          if (!isUser) {
            for (let j = i - 1; j >= 0; j--) {
              if (messages[j].role === "user") {
                precedingUserText = messages[j].content
                  .replace(/\[[\s\S]*?\]/g, "")
                  .trim()
                  .slice(0, 300);
                break;
              }
            }
          }

          return (
            <div
              key={msg.id}
              className={`flex items-end gap-2.5 sm:gap-3 ${isUser ? "justify-start" : "justify-end"}`}
            >
              {/* Client avatar (left side) */}
              {isUser && (
                <div className="shrink-0 mb-5">
                  {conversation.profile_pic ? (
                    <Image
                      src={conversation.profile_pic}
                      alt={conversation.name ?? "Cliente"}
                      width={30}
                      height={30}
                      className="w-[30px] h-[30px] rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="w-[30px] h-[30px] rounded-full bg-gradient-to-br from-purple-500 to-pink-500 grid place-items-center text-white text-[11px] font-bold">
                      {getInitials(conversation.name, conversation.username)}
                    </div>
                  )}
                </div>
              )}

              <div className={`max-w-[82%] sm:max-w-md xl:max-w-lg flex flex-col ${isUser ? "items-start" : "items-end"}`}>
                <div
                  className={`px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                    isUser
                      ? "bg-zinc-800 text-zinc-50 rounded-2xl rounded-bl-md"
                      : "bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white rounded-2xl rounded-br-md shadow-lg shadow-fuchsia-950/25"
                  }`}
                >
                  {displayContent}
                </div>
                <div className="flex items-center gap-1.5 mt-1 px-1">
                  {!isUser && (
                    <span className="text-fuchsia-300 text-[11px] font-semibold">IA</span>
                  )}
                  <span className="text-zinc-500 text-[11px] tabular-nums">{formatTime(msg.created_at)}</span>
                </div>

                {/* Correction affordance — only on AI messages */}
                {!isUser && (
                  <CorrectionControl
                    conversationId={conversation.id}
                    originalText={displayContent}
                    precedingUserText={precedingUserText}
                  />
                )}
              </div>
            </div>
          );
        })}
        </div>

        {/* Jump to latest — appears only when scrolled up */}
        {!atBottom && (
          <button
            onClick={() => jumpToBottom(true)}
            className="absolute bottom-4 right-4 sm:right-6 z-10 flex items-center gap-1.5 bg-zinc-800/95 hover:bg-zinc-700 border border-white/10 text-zinc-100 text-xs font-semibold h-10 px-4 rounded-full shadow-xl backdrop-blur transition-all active:scale-95"
            title="Ir para as mensagens mais recentes"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
            </svg>
            Recentes
          </button>
        )}
      </div>

      {/* Training panel — shown when in human/training mode */}
      <TrainingPanel conversation={conversation} messages={messages} />

      {/* Input */}
      <div className="shrink-0 border-t border-white/[0.06] bg-zinc-900/60 backdrop-blur-md px-3 sm:px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {conversation.mode === "human" && (
          <p className="flex items-center gap-1.5 text-amber-300 text-xs font-medium mb-2 px-1">
            <span aria-hidden>⏸️</span>
            IA pausada nesta conversa — o que você digitar aqui vai direto ao cliente.
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Escreva uma mensagem..."
            rows={1}
            className="flex-1 min-h-12 max-h-32 bg-zinc-800 text-white placeholder:text-zinc-500 rounded-2xl border border-white/[0.08] px-4 py-3 text-base lg:text-sm resize-none outline-none focus:border-fuchsia-500/40 focus:ring-2 focus:ring-fuchsia-500/15 transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            aria-label="Enviar mensagem"
            className="shrink-0 w-12 h-12 grid place-items-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 hover:brightness-110 text-white shadow-lg shadow-fuchsia-950/30 transition-all duration-150 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSending ? (
              <span className="text-sm font-bold">...</span>
            ) : (
              <svg className="w-5 h-5 -ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Per-message correction ─────────────────────────────────────────────────
// Lets the owner rewrite an AI reply directly in the conversation. The fix is
// saved as a structured training rule that every webhook loads on the next
// message — so it is active instantly. It does NOT send anything to the client.
function CorrectionControl({
  conversationId,
  originalText,
  precedingUserText,
}: {
  conversationId: string;
  originalText: string;
  precedingUserText: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(originalText);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function handleOpen() {
    setText(originalText);
    setOpen(true);
  }

  async function handleSave() {
    const correction = text.trim();
    if (!correction || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/correct`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka",
        },
        body: JSON.stringify({ correction, originalQuestion: precedingUserText }),
      });
      if (res.ok) {
        setSaved(true);
        setOpen(false);
        setTimeout(() => setSaved(false), 4000);
      }
    } catch { /* ignore */ }
    setSaving(false);
  }

  if (saved) {
    return (
      <p className="text-emerald-300 text-xs mt-1 px-1 font-medium animate-fade-in">
        ✓ Correção salva — a IA já aplica a partir da próxima mensagem
      </p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        className="self-end flex items-center gap-1 text-amber-300/90 hover:text-amber-200 text-xs font-medium mt-1 px-2 py-1 rounded-lg hover:bg-amber-500/10 transition-colors"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l6-6 3 3-6 6H9v-3z" />
        </svg>
        Corrigir
      </button>
    );
  }

  return (
    <div className="w-full mt-2 space-y-2 animate-fade-in">
      <p className="text-amber-300 text-xs font-semibold">Como a IA deveria ter respondido?</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        autoFocus
        className="w-full bg-zinc-900 border border-amber-500/30 focus:border-amber-400/60 rounded-xl px-3 py-2.5 text-base lg:text-sm text-white placeholder:text-zinc-500 outline-none focus:ring-2 focus:ring-amber-500/15 resize-none transition-colors"
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={() => setOpen(false)}
          className="h-9 px-3.5 rounded-full text-xs font-semibold text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 border border-white/10 transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={!text.trim() || saving}
          className="h-9 px-3.5 rounded-full text-xs font-bold text-zinc-950 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Salvando..." : "Corrigir e salvar"}
        </button>
      </div>
    </div>
  );
}

// ─── Training Panel ────────────────────────────────────────────────────────
function TrainingPanel({ conversation, messages }: { conversation: ConversationWithLastMessage; messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const [ownerResponse, setOwnerResponse] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const lastClientMsg = [...messages].reverse().find((m) => m.role === "user");

  const handleSave = useCallback(async () => {
    if (!ownerResponse.trim() || !lastClientMsg) return;
    setSaving(true);
    try {
      await fetch(`/api/train?secret=${process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientMessage: lastClientMsg.content
            .replace(/\[Floor plan analysis:[\s\S]*?\]/g, "[floor plan]")
            .replace(/\[SYSTEM:[\s\S]*?\]/g, "")
            .trim()
            .slice(0, 300),
          ownerResponse: ownerResponse.trim(),
          context: conversation.username ?? conversation.igsid,
        }),
      });
      setSaved(true);
      setOwnerResponse("");
      setOpen(false);
      setTimeout(() => setSaved(false), 3000);
    } catch { /* ignore */ }
    setSaving(false);
  }, [ownerResponse, lastClientMsg, conversation]);

  if (conversation.mode !== "human") return null;

  return (
    <div className="shrink-0 border-t border-amber-500/15 bg-amber-500/[0.06] px-3 sm:px-4 py-2">
      {saved && (
        <p className="text-emerald-300 text-xs mb-1 font-medium animate-fade-in">
          ✓ Exemplo salvo — o agente vai aprender com essa resposta
        </p>
      )}
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-amber-300 hover:text-amber-200 text-xs font-medium py-1.5 transition-colors"
        >
          <span aria-hidden>📚</span>
          Salvar minha resposta como exemplo de treinamento
        </button>
      ) : (
        <div className="space-y-2 py-1 animate-fade-in">
          <p className="text-amber-300 text-xs font-semibold">Como você respondeu esse cliente?</p>
          {lastClientMsg && (
            <p className="text-zinc-300 text-xs bg-zinc-900/80 border border-white/[0.06] rounded-lg px-2.5 py-1.5 truncate">
              Cliente: {lastClientMsg.content.replace(/\[[\s\S]*?\]/g, "").trim().slice(0, 80)}
            </p>
          )}
          <textarea
            value={ownerResponse}
            onChange={(e) => setOwnerResponse(e.target.value)}
            placeholder="Digite o que você respondeu para o cliente..."
            rows={2}
            className="w-full bg-zinc-900 border border-white/[0.08] text-white placeholder:text-zinc-500 rounded-xl px-3 py-2.5 text-base lg:text-xs resize-none outline-none focus:border-amber-400/50 focus:ring-2 focus:ring-amber-500/15 transition-colors"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!ownerResponse.trim() || saving}
              className="h-9 px-3.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-zinc-950 text-xs font-bold transition-colors"
            >
              {saving ? "Salvando..." : "Salvar exemplo"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="h-9 px-3 text-zinc-400 text-xs font-medium hover:text-zinc-200 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
