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
          className="absolute inset-0 overflow-y-auto p-6 space-y-4"
        >
        {messages.length === 0 && (
          <div className="text-center text-gray-500 text-sm mt-8">
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
              className={`flex items-end gap-3 ${isUser ? "justify-start" : "justify-end"}`}
            >
              {/* User avatar (left side) */}
              {isUser && (
                <div className="flex-shrink-0 mb-1">
                  {conversation.profile_pic ? (
                    <Image
                      src={conversation.profile_pic}
                      alt={conversation.name ?? "User"}
                      width={32}
                      height={32}
                      className="rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-xs font-bold">
                      {getInitials(conversation.name, conversation.username)}
                    </div>
                  )}
                </div>
              )}

              <div className={`max-w-xs lg:max-w-md xl:max-w-lg ${isUser ? "" : "items-end flex flex-col"}`}>
                <div
                  className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    isUser
                      ? "bg-gray-700 text-white rounded-bl-sm"
                      : "bg-gradient-to-r from-purple-600 to-red-500 text-white rounded-br-sm"
                  }`}
                >
                  {displayContent}
                </div>
                <div className="flex items-center gap-1 mt-1 px-1">
                  {!isUser && (
                    <span className="text-purple-400 text-xs">AI ·</span>
                  )}
                  <span className="text-gray-500 text-xs">{formatTime(msg.created_at)}</span>
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
            className="absolute bottom-4 right-6 z-10 flex items-center gap-1.5 bg-gray-800/95 hover:bg-gray-700 border border-gray-700 text-gray-100 text-xs font-semibold px-3 py-2 rounded-full shadow-lg backdrop-blur transition-colors"
            title="Ir para as mensagens mais recentes"
          >
            <span className="text-sm leading-none">↓</span>
            Recentes
          </button>
        )}
      </div>

      {/* Training panel — shown when in human/training mode */}
      <TrainingPanel conversation={conversation} messages={messages} />

      {/* Input */}
      <div className="border-t border-gray-800 p-4 bg-gray-900">
        {conversation.mode === "human" && (
          <p className="text-amber-400 text-xs mb-2 flex items-center gap-1">
            <span>⏸️</span>
            IA pausada nesta conversa, você responde manualmente. O que digitar aqui vai direto ao cliente.
          </p>
        )}
        <div className="flex items-end gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-gray-800 text-white placeholder-gray-500 rounded-xl px-4 py-3 text-sm resize-none outline-none focus:ring-1 focus:ring-purple-500 max-h-32"
            style={{ minHeight: "44px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 text-white px-5 py-3 rounded-xl text-sm font-medium transition-all flex-shrink-0"
          >
            {isSending ? "..." : "Send"}
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
      <p className="text-green-400 text-xs mt-1 px-1 font-medium">
        ✓ Correção salva — a IA já aplica a partir da próxima mensagem
      </p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        className="self-end text-yellow-400/80 hover:text-yellow-300 text-xs mt-1 px-1 flex items-center gap-1"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l6-6 3 3-6 6H9v-3z" />
        </svg>
        Corrigir
      </button>
    );
  }

  return (
    <div className="w-full mt-2 space-y-2">
      <p className="text-yellow-400 text-xs font-medium">Como a IA deveria ter respondido?</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        autoFocus
        className="w-full bg-gray-800 border border-yellow-700 focus:border-yellow-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none resize-none"
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={() => setOpen(false)}
          className="text-xs font-medium text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-1.5 rounded-full"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={!text.trim() || saving}
          className="text-xs font-medium text-black bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 rounded-full"
        >
          {saving ? "Salvando..." : "Corrigir e enviar"}
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
    <div className="border-t border-amber-900/40 bg-amber-950/20 px-4 py-2">
      {saved && (
        <p className="text-green-400 text-xs mb-1 font-medium">✓ Exemplo salvo — o agente vai aprender com essa resposta</p>
      )}
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="text-amber-400 text-xs hover:text-amber-300 flex items-center gap-1.5 py-1"
        >
          <span>📚</span>
          Salvar minha resposta como exemplo de treinamento
        </button>
      ) : (
        <div className="space-y-2 py-1">
          <p className="text-amber-400 text-xs font-medium">Como você respondeu esse cliente?</p>
          {lastClientMsg && (
            <p className="text-gray-400 text-xs bg-gray-800 rounded px-2 py-1 truncate">
              Cliente: {lastClientMsg.content.replace(/\[[\s\S]*?\]/g, "").trim().slice(0, 80)}
            </p>
          )}
          <textarea
            value={ownerResponse}
            onChange={(e) => setOwnerResponse(e.target.value)}
            placeholder="Digite o que você respondeu para o cliente..."
            rows={2}
            className="w-full bg-gray-800 text-white placeholder-gray-500 rounded-lg px-3 py-2 text-xs resize-none outline-none focus:ring-1 focus:ring-amber-500"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!ownerResponse.trim() || saving}
              className="bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black text-xs font-bold px-3 py-1.5 rounded-lg"
            >
              {saving ? "Salvando..." : "Salvar exemplo"}
            </button>
            <button onClick={() => setOpen(false)} className="text-gray-500 text-xs hover:text-gray-300 px-2">
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
