"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import { ConversationWithLastMessage, Message } from "@/lib/types";
import { CHANNEL_TINT, getChannel, getInitials } from "@/lib/channel";
import { cleanClientText } from "@/lib/conversation-search";

interface Props {
  conversation: ConversationWithLastMessage;
  messages: Message[];
  onSendMessage: (text: string) => Promise<{ ok: boolean; error?: string }>;
  isSending: boolean;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ChatPanel({ conversation, messages, onSendMessage, isSending }: Props) {
  const [input, setInput] = useState("");
  // Falha de envio (02/11/2026): mostrada embaixo da caixa; o texto volta para
  // a caixa para o dono corrigir ou reenviar. `warning` = entregue com aviso.
  const [sendError, setSendError] = useState<{ text: string; warning: boolean } | null>(null);
  // Scroll the MESSAGES container directly — never scrollIntoView, which would
  // also scroll ancestor elements (and the page), hiding the headers/buttons.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const tint = CHANNEL_TINT[getChannel(conversation.igsid)];

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
    setSendError(null);
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
    setSendError(null);
    const result = await onSendMessage(text);
    if (!result.ok) {
      // O cliente NÃO recebeu: devolve o texto e mostra o motivo.
      setInput((current) => (current.trim() ? current : text));
      setSendError({ text: result.error ?? "Falha no envio. O cliente não recebeu a mensagem.", warning: false });
      return;
    }
    if (result.error) setSendError({ text: result.error, warning: true });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Mensagens — rolagem própria; os cabeçalhos acima ficam fixos */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto px-3 sm:px-6 py-5"
        >
        {/* Largura máxima: num monitor largo as duas pontas da conversa ficariam a metros uma da outra */}
        <div className="mx-auto w-full max-w-4xl space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-muted text-[13px] mt-10">
            Nenhuma mensagem nesta conversa ainda
          </div>
        )}

        {messages.map((msg, i) => {
          const isUser = msg.role === "user";
          // Strip internal context injections before displaying
          const displayContent = cleanClientText(msg.content) || (isUser ? "[mídia]" : "");

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
              {/* Avatar do cliente (lado esquerdo) */}
              {isUser && (
                <div className="shrink-0 mb-5">
                  {conversation.profile_pic ? (
                    <Image
                      src={conversation.profile_pic}
                      alt=""
                      width={28}
                      height={28}
                      className="w-7 h-7 rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-semibold ${tint.bg} ${tint.text}`}>
                      {getInitials(conversation.name, conversation.username)}
                    </div>
                  )}
                </div>
              )}

              <div className={`max-w-[82%] sm:max-w-md xl:max-w-lg flex flex-col ${isUser ? "items-start" : "items-end"}`}>
                <div
                  className={`px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-ink ${
                    isUser
                      ? "bg-soft rounded-2xl rounded-bl-md"
                      : "bg-accent/[.14] ring-1 ring-inset ring-accent/15 rounded-2xl rounded-br-md"
                  }`}
                >
                  {displayContent}
                </div>
                <div className="flex items-center gap-1.5 mt-1 px-1 text-[11px] text-muted tabular-nums">
                  {!isUser && <span className="font-medium">IA</span>}
                  <span>{formatTime(msg.created_at)}</span>
                </div>

                {/* Correção — só em mensagens da IA */}
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
        </div>

        {/* Ir para o fim — só quando rolou para cima */}
        {!atBottom && (
          <button
            onClick={() => jumpToBottom(true)}
            className="absolute bottom-4 right-4 sm:right-6 z-10 flex items-center gap-1.5 bg-card ring-1 ring-line text-ink text-[12px] font-medium h-9 px-3.5 rounded-full shadow-pop transition-colors hover:bg-soft"
            title="Ir para as mensagens mais recentes"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
            </svg>
            Recentes
          </button>
        )}
      </div>

      {/* Treino — aparece no modo humano */}
      <TrainingPanel conversation={conversation} messages={messages} />

      {/* Caixa de envio */}
      <div className="shrink-0 border-t border-line bg-page px-3 sm:px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-4xl">
        {conversation.mode === "human" && (
          <p className="flex items-center gap-1.5 text-warn text-[12px] font-medium mb-2 px-1">
            <span className="w-1.5 h-1.5 rounded-full bg-warn" />
            IA pausada — o que você escrever aqui vai direto ao cliente
          </p>
        )}
        {sendError && (
          <div
            role="alert"
            className={`flex items-start gap-2 mb-2 px-3 py-2 rounded-xl ring-1 ring-inset text-[12px] leading-relaxed ${
              sendError.warning
                ? "bg-warn/10 ring-warn/25 text-warn"
                : "bg-down/10 ring-down/25 text-down"
            }`}
          >
            <span className="flex-1 min-w-0 break-words">
              {sendError.warning ? "" : <strong className="font-semibold">Mensagem não enviada. </strong>}
              {sendError.text}
            </span>
            <button
              type="button"
              onClick={() => setSendError(null)}
              aria-label="Fechar aviso"
              className="shrink-0 -mr-1 w-6 h-6 grid place-items-center rounded-md hover:bg-soft"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Escreva uma mensagem…"
            title="Enter envia · Shift+Enter quebra a linha"
            rows={1}
            className="flex-1 min-h-12 max-h-32 bg-card text-ink placeholder:text-muted rounded-2xl border border-line px-4 py-3 text-base lg:text-[14px] resize-none outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            aria-label="Enviar mensagem"
            className="shrink-0 w-12 h-12 grid place-items-center rounded-2xl bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSending ? (
              <span className="w-4 h-4 rounded-full border-2 border-on-accent/30 border-t-on-accent animate-spin" />
            ) : (
              <svg className="w-5 h-5 -ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
              </svg>
            )}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}

// ─── Correção por mensagem ──────────────────────────────────────────────────
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
      <p className="flex items-center gap-1 text-up text-[12px] mt-1 px-1 font-medium animate-fade-in">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Correção salva · vale a partir da próxima mensagem
      </p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        className="self-end flex items-center gap-1 text-muted hover:text-warn text-[12px] font-medium mt-1 px-2 py-1 rounded-lg hover:bg-warn/10 transition-colors"
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
      <p className="text-warn text-[12px] font-medium">Como a IA deveria ter respondido?</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        autoFocus
        className="w-full bg-card border border-warn/40 rounded-xl px-3 py-2.5 text-base lg:text-[14px] text-ink placeholder:text-muted outline-none focus:border-warn focus:ring-2 focus:ring-warn/20 resize-none transition-colors"
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={() => setOpen(false)}
          className="h-8 px-3 rounded-full text-[12px] font-medium text-ink-2 hover:text-ink bg-card hover:bg-soft border border-line transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={!text.trim() || saving}
          className="h-8 px-3 rounded-full text-[12px] font-semibold text-on-warn bg-warn hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Salvando…" : "Salvar correção"}
        </button>
      </div>
    </div>
  );
}

// ─── Treino (modo humano) ───────────────────────────────────────────────────
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
    <div className="shrink-0 border-t border-warn/15 bg-warn/[.06] px-3 sm:px-4 py-2">
      {saved && (
        <p className="text-up text-[12px] mb-1 font-medium animate-fade-in">Exemplo salvo</p>
      )}
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-warn hover:brightness-110 text-[12px] font-medium py-1.5 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
          Salvar minha resposta como exemplo
        </button>
      ) : (
        <div className="space-y-2 py-1 animate-fade-in">
          <p className="text-warn text-[12px] font-medium">Como você respondeu este cliente?</p>
          {lastClientMsg && (
            <p className="text-ink-2 text-[12px] bg-card ring-1 ring-inset ring-line rounded-lg px-2.5 py-1.5 truncate">
              Cliente: {cleanClientText(lastClientMsg.content).slice(0, 80)}
            </p>
          )}
          <textarea
            value={ownerResponse}
            onChange={(e) => setOwnerResponse(e.target.value)}
            placeholder="O que você respondeu ao cliente…"
            rows={2}
            className="w-full bg-card border border-line text-ink placeholder:text-muted rounded-xl px-3 py-2.5 text-base lg:text-[13px] resize-none outline-none focus:border-warn/60 focus:ring-2 focus:ring-warn/20 transition-colors"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!ownerResponse.trim() || saving}
              className="h-8 px-3 rounded-full bg-warn text-on-warn hover:brightness-110 disabled:opacity-50 text-[12px] font-semibold transition-colors"
            >
              {saving ? "Salvando…" : "Salvar exemplo"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="h-8 px-3 text-muted text-[12px] font-medium hover:text-ink transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
