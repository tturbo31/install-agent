"use client";

import { useRef, useState, useCallback, useEffect, KeyboardEvent, ChangeEvent } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrainingMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "pending" | "good" | "corrected" | "correcting";
  correctedContent?: string;
  aiMsgId?: string;
};

type ApiChatMessage = { role: "user" | "assistant"; content: string };

// ---------------------------------------------------------------------------
// Suggestion chips shown in the empty state
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  "Hi, how much for vinyl flooring?",
  "I want to do the whole house",
  "Is labor included?",
  "Can I send you a floor plan?",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toApiMessages(messages: TrainingMessage[]): ApiChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ThinkingBubble() {
  return (
    <div className="flex flex-col items-start gap-1 animate-fade-in">
      <span className="text-[11px] font-semibold text-zinc-500 px-1">IA</span>
      <div className="bg-zinc-800 rounded-2xl rounded-tl-md px-4 py-3.5 flex gap-1.5 items-center">
        <span className="w-2 h-2 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  msg: TrainingMessage;
  sandboxId: string | null;
  onMarkGood: (id: string) => void;
  onStartCorrect: (id: string) => void;
  onCancelCorrect: (id: string) => void;
  onSaveCorrection: (id: string, correction: string) => Promise<void>;
}

function MessageBubble({
  msg,
  sandboxId,
  onMarkGood,
  onStartCorrect,
  onCancelCorrect,
  onSaveCorrection,
}: MessageBubbleProps) {
  const [correctionText, setCorrectionText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isUser = msg.role === "user";

  useEffect(() => {
    if (msg.status === "correcting" && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [msg.status]);

  async function handleSave() {
    if (!correctionText.trim()) return;
    setIsSaving(true);
    await onSaveCorrection(msg.id, correctionText.trim());
    setCorrectionText("");
    setIsSaving(false);
  }

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1 animate-fade-in">
        <span className="text-[11px] font-semibold text-zinc-500 px-1">Cliente (você)</span>
        <div className="bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white rounded-2xl rounded-tr-md px-4 py-2.5 max-w-[85%] sm:max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap break-words shadow-lg shadow-fuchsia-950/25">
          {msg.content}
        </div>
      </div>
    );
  }

  // Assistant bubble
  const borderClass =
    msg.status === "corrected"
      ? "border border-red-400/50"
      : "border border-transparent";

  return (
    <div className="flex flex-col items-start gap-1 animate-fade-in">
      <span className="text-[11px] font-semibold text-zinc-500 px-1">IA</span>

      {/* Original AI bubble */}
      <div
        className={`bg-zinc-800 text-zinc-50 rounded-2xl rounded-tl-md px-4 py-2.5 max-w-[85%] sm:max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap break-words ${borderClass}`}
      >
        {msg.status === "corrected" && (
          <p className="text-red-300 text-xs font-semibold mb-1">Resposta incorreta</p>
        )}
        {msg.content}
      </div>

      {/* Action buttons — only shown while pending */}
      {msg.status === "pending" && sandboxId && (
        <div className="flex gap-2 ml-1 mt-0.5">
          <button
            onClick={() => onMarkGood(msg.id)}
            className="flex items-center gap-1.5 h-9 px-3.5 rounded-full text-xs font-semibold text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-400/25 transition-all active:scale-95"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Boa resposta
          </button>
          <button
            onClick={() => onStartCorrect(msg.id)}
            className="flex items-center gap-1.5 h-9 px-3.5 rounded-full text-xs font-semibold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/25 transition-all active:scale-95"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l6-6 3 3-6 6H9v-3z" />
            </svg>
            Corrigir
          </button>
        </div>
      )}

      {/* Correction textarea */}
      {msg.status === "correcting" && (
        <div className="w-full max-w-[85%] sm:max-w-[75%] mt-1 ml-1 space-y-2 animate-fade-in">
          <textarea
            ref={textareaRef}
            value={correctionText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCorrectionText(e.target.value)}
            placeholder="Como deveria ter respondido?"
            rows={3}
            className="w-full bg-zinc-900 border border-amber-500/30 focus:border-amber-400/60 rounded-xl px-3 py-2.5 text-base lg:text-sm text-white placeholder:text-zinc-500 outline-none focus:ring-2 focus:ring-amber-500/15 resize-none transition-colors"
          />
          <div className="flex gap-2">
            <button
              onClick={() => onCancelCorrect(msg.id)}
              className="h-9 px-3.5 rounded-full text-xs font-semibold text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 border border-white/10 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={!correctionText.trim() || isSaving}
              className="h-9 px-3.5 rounded-full text-xs font-bold text-zinc-950 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving ? "Salvando..." : "Salvar correção"}
            </button>
          </div>
        </div>
      )}

      {/* Corrected replacement bubble */}
      {msg.status === "corrected" && msg.correctedContent && (
        <div className="flex flex-col items-start gap-1 mt-1 animate-fade-in">
          <div className="bg-emerald-500/10 border border-emerald-400/30 text-emerald-100 rounded-2xl rounded-tl-md px-4 py-2.5 max-w-[85%] sm:max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap break-words">
            <p className="text-emerald-300 text-xs font-semibold mb-1">✓ Correção salva</p>
            {msg.correctedContent}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function TrainingSimulator() {
  const [messages, setMessages] = useState<TrainingMessage[]>([]);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  function handleNewSession() {
    setMessages([]);
    setSandboxId(null);
    setInputText("");
    setImageBase64(null);
    setImagePreview(null);
  }

  function handleImageSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      setImageBase64(result);
      setImagePreview(result);
    };
    reader.readAsDataURL(file);

    // Reset input so the same file can be re-selected
    e.target.value = "";
  }

  function handleRemoveImage() {
    setImageBase64(null);
    setImagePreview(null);
  }

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if ((!text && !imageBase64) || isLoading) return;

    const userDisplayContent = text || (imageBase64 ? "[Image]" : "");

    const userMsg: TrainingMessage = {
      id: uid(),
      role: "user",
      content: userDisplayContent,
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInputText("");
    setIsLoading(true);

    const capturedImage = imageBase64;
    setImageBase64(null);
    setImagePreview(null);

    try {
      const res = await fetch("/api/training/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka",
        },
        body: JSON.stringify({
          messages: toApiMessages(nextMessages),
          ...(capturedImage ? { imageBase64: capturedImage } : {}),
          ...(sandboxId ? { sandboxId } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error ?? "Request failed");

      // Update user message content in case the image was analyzed and enriched
      if (data.enrichedUserMsg && data.enrichedUserMsg !== userDisplayContent) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userMsg.id ? { ...m, content: data.enrichedUserMsg } : m
          )
        );
      }

      if (!sandboxId) setSandboxId(data.sandboxId);

      const aiMsg: TrainingMessage = {
        id: uid(),
        role: "assistant",
        content: data.response,
        status: "pending",
        aiMsgId: data.aiMsgId,
      };

      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const errorMsg: TrainingMessage = {
        id: uid(),
        role: "assistant",
        content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }, [inputText, imageBase64, isLoading, messages, sandboxId]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleMarkGood(id: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: "good" } : m))
    );
  }

  function handleStartCorrect(id: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: "correcting" } : m))
    );
  }

  function handleCancelCorrect(id: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: "pending" } : m))
    );
  }

  async function handleSaveCorrection(id: string, correction: string) {
    const msg = messages.find((m) => m.id === id);
    if (!msg || !msg.aiMsgId || !sandboxId) return;

    // Find the user message that immediately preceded this AI message
    const msgIndex = messages.findIndex((m) => m.id === id);
    const precedingUserMsg = messages.slice(0, msgIndex).reverse().find((m) => m.role === "user");
    const originalQuestion = precedingUserMsg?.content ?? "";

    await fetch("/api/training/chat", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka",
      },
      body: JSON.stringify({
        sandboxId,
        aiMsgId: msg.aiMsgId,
        correction,
        originalQuestion,
      }),
    });

    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? { ...m, status: "corrected", correctedContent: correction }
          : m
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-3 sm:px-5 py-3.5 border-b border-white/[0.06] bg-zinc-900/60 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border border-white/10 grid place-items-center shrink-0">
            <svg className="w-5 h-5 text-fuchsia-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.63 48.63 0 0112 20.904a48.63 48.63 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white tracking-tight leading-tight">Simulador de IA</h2>
            <p className="text-[11px] text-zinc-400 leading-tight mt-0.5 truncate">
              Escreva como cliente · A IA responde como no direct · Corrija quando errar
            </p>
          </div>
        </div>
        <button
          onClick={handleNewSession}
          className="flex items-center gap-1.5 h-9 px-3 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 border border-white/10 transition-all active:scale-95 shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          <span className="hidden sm:inline">Nova sessão</span>
        </button>
      </div>

      {/* Message area */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-5">
        <div className="max-w-3xl mx-auto w-full space-y-4 min-h-full flex flex-col justify-end">
        {messages.length === 0 && !isLoading ? (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center py-10 animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/15 to-fuchsia-500/15 border border-white/10 grid place-items-center">
              <svg className="w-8 h-8 text-fuchsia-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-white tracking-tight">Simule uma conversa de cliente</p>
              <p className="text-sm text-zinc-400 mt-1 max-w-xs">
                A IA vai responder exatamente como faria no Instagram ou WhatsApp
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInputText(s)}
                  className="text-xs font-medium text-zinc-200 bg-zinc-800/80 hover:bg-zinc-700 border border-white/10 px-3.5 py-2.5 rounded-full transition-all active:scale-95"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                sandboxId={sandboxId}
                onMarkGood={handleMarkGood}
                onStartCorrect={handleStartCorrect}
                onCancelCorrect={handleCancelCorrect}
                onSaveCorrection={handleSaveCorrection}
              />
            ))}
            {isLoading && <ThinkingBubble />}
          </>
        )}
        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-white/[0.06] bg-zinc-900/60 backdrop-blur-md px-3 sm:px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="max-w-3xl mx-auto w-full">
          {/* Image preview */}
          {imagePreview && (
            <div className="mb-2 flex items-center gap-2 animate-fade-in">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imagePreview}
                alt="Preview"
                className="h-14 w-14 object-cover rounded-xl border border-white/10"
              />
              <button
                onClick={handleRemoveImage}
                className="w-9 h-9 grid place-items-center rounded-lg text-zinc-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                aria-label="Remover imagem"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          <div className="flex items-end gap-2">
            {/* Image upload button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 w-12 h-12 grid place-items-center rounded-2xl bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-zinc-400 hover:text-zinc-200 transition-all active:scale-95"
              aria-label="Anexar imagem"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />

            {/* Text input — 16px on mobile prevents iOS auto-zoom */}
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escreva como um cliente..."
              rows={1}
              className="flex-1 min-h-12 max-h-40 bg-zinc-800 border border-white/[0.08] focus:border-fuchsia-500/40 focus:ring-2 focus:ring-fuchsia-500/15 rounded-2xl px-4 py-3 text-base lg:text-sm text-white placeholder:text-zinc-500 outline-none resize-none transition-colors overflow-y-auto"
            />

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={(!inputText.trim() && !imageBase64) || isLoading}
              className="shrink-0 w-12 h-12 grid place-items-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 hover:brightness-110 text-white shadow-lg shadow-fuchsia-950/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 active:scale-95"
              aria-label="Enviar"
            >
              <svg className="w-5 h-5 -ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>

          <p className="hidden sm:block text-[11px] text-zinc-500 mt-2 text-center">
            Enter para enviar · Shift+Enter para nova linha
          </p>
        </div>
      </div>
    </div>
  );
}
