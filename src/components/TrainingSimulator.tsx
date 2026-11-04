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
    <div className="flex flex-col items-start gap-1" role="status" aria-label="A IA está escrevendo">
      <span className="text-[11px] font-medium text-muted px-1">IA</span>
      <div className="bg-accent/[.14] ring-1 ring-inset ring-accent/15 rounded-2xl rounded-tl-md px-4 py-3.5 flex gap-1.5 items-center">
        <span className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:300ms]" />
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
      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px] font-medium text-muted px-1">Cliente (você)</span>
        <div className="bg-soft text-ink rounded-2xl rounded-tr-md px-4 py-2.5 max-w-[85%] sm:max-w-[75%] text-[14px] leading-relaxed whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    );
  }

  // Assistant bubble
  const wrong = msg.status === "corrected";

  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-[11px] font-medium text-muted px-1">IA</span>

      {/* Resposta original */}
      <div
        className={`rounded-2xl rounded-tl-md px-4 py-2.5 max-w-[85%] sm:max-w-[75%] text-[14px] leading-relaxed whitespace-pre-wrap break-words text-ink ring-1 ring-inset ${
          wrong ? "bg-down/[.08] ring-down/40" : "bg-accent/[.14] ring-accent/15"
        }`}
      >
        {wrong && <p className="text-down text-[12px] font-medium mb-1">Resposta incorreta</p>}
        {msg.content}
      </div>

      {/* Ações — só enquanto pendente */}
      {msg.status === "pending" && sandboxId && (
        <div className="flex gap-2 ml-1 mt-0.5">
          <button
            onClick={() => onMarkGood(msg.id)}
            className="flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-medium text-up bg-up/10 hover:bg-up/20 ring-1 ring-inset ring-up/25 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Boa resposta
          </button>
          <button
            onClick={() => onStartCorrect(msg.id)}
            className="flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-medium text-warn bg-warn/10 hover:bg-warn/20 ring-1 ring-inset ring-warn/25 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l6-6 3 3-6 6H9v-3z" />
            </svg>
            Corrigir
          </button>
        </div>
      )}

      {/* Caixa de correção */}
      {msg.status === "correcting" && (
        <div className="w-full max-w-[85%] sm:max-w-[75%] mt-1 ml-1 space-y-2 animate-fade-in">
          <textarea
            ref={textareaRef}
            value={correctionText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCorrectionText(e.target.value)}
            placeholder="Como deveria ter respondido?"
            rows={3}
            className="w-full bg-card border border-warn/40 rounded-xl px-3 py-2.5 text-base lg:text-[14px] text-ink placeholder:text-muted outline-none focus:border-warn focus:ring-2 focus:ring-warn/20 resize-none transition-colors"
          />
          <div className="flex gap-2">
            <button
              onClick={() => onCancelCorrect(msg.id)}
              className="h-8 px-3 rounded-full text-[12px] font-medium text-ink-2 hover:text-ink bg-card hover:bg-soft border border-line transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={!correctionText.trim() || isSaving}
              className="h-8 px-3 rounded-full text-[12px] font-semibold text-on-warn bg-warn hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving ? "Salvando…" : "Salvar correção"}
            </button>
          </div>
        </div>
      )}

      {/* Resposta corrigida */}
      {msg.status === "corrected" && msg.correctedContent && (
        <div className="flex flex-col items-start gap-1 mt-1 animate-fade-in">
          <div className="bg-up/10 ring-1 ring-inset ring-up/25 text-ink rounded-2xl rounded-tl-md px-4 py-2.5 max-w-[85%] sm:max-w-[75%] text-[14px] leading-relaxed whitespace-pre-wrap break-words">
            <p className="text-up text-[12px] font-medium mb-1">Correção salva</p>
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
      {/* Cabeçalho */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-3 sm:px-5 h-14 lg:h-16 border-b border-line bg-page">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-soft ring-1 ring-inset ring-line grid place-items-center shrink-0 text-ink-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.63 48.63 0 0112 20.904a48.63 48.63 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
            </svg>
          </div>
          <div className="min-w-0" title="Escreva como um cliente; a IA responde como no direct. Corrija quando errar.">
            <h2 className="text-[14px] font-semibold text-ink tracking-tight leading-tight">Simulador</h2>
            <p className="text-[12px] text-muted leading-tight mt-0.5 truncate">Treino sem cliente real</p>
          </div>
        </div>
        <button
          onClick={handleNewSession}
          className="flex items-center gap-1.5 h-8 px-3 rounded-full border border-line bg-card hover:bg-soft text-ink-2 text-[12px] font-medium transition-colors shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="hidden sm:inline">Nova sessão</span>
        </button>
      </div>

      {/* Mensagens */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-5">
        <div className="max-w-3xl mx-auto w-full space-y-4 min-h-full flex flex-col justify-end">
        {messages.length === 0 && !isLoading ? (
          /* Vazio: diz o que fazer e dá por onde começar */
          <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center py-10">
            <div>
              <p className="text-[15px] font-semibold text-ink tracking-tight">Escreva como um cliente escreveria</p>
              <p className="text-[13px] text-muted mt-1 max-w-xs">A IA responde exatamente como no Instagram, Messenger ou WhatsApp.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInputText(s)}
                  className="text-[12px] font-medium text-ink-2 bg-card hover:bg-soft border border-line px-3.5 py-2 rounded-full transition-colors"
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

      {/* Caixa de envio */}
      <div className="shrink-0 border-t border-line bg-page px-3 sm:px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="max-w-3xl mx-auto w-full">
          {/* Prévia da imagem */}
          {imagePreview && (
            <div className="mb-2 flex items-center gap-2 animate-fade-in">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imagePreview}
                alt="Imagem anexada"
                className="h-14 w-14 object-cover rounded-xl ring-1 ring-line"
              />
              <button
                onClick={handleRemoveImage}
                className="w-8 h-8 grid place-items-center rounded-lg text-muted hover:text-down hover:bg-down/10 transition-colors"
                aria-label="Remover imagem"
                title="Remover imagem"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          <div className="flex items-end gap-2">
            {/* Anexar imagem */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 w-12 h-12 grid place-items-center rounded-2xl bg-card hover:bg-soft border border-line text-muted hover:text-ink transition-colors"
              aria-label="Anexar imagem"
              title="Anexar imagem (planta ou foto do piso)"
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

            {/* Texto — 16px no celular evita o zoom do iOS */}
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escreva como um cliente…"
              title="Enter envia · Shift+Enter quebra a linha"
              rows={1}
              className="flex-1 min-h-12 max-h-40 bg-card border border-line focus:border-accent/50 focus:ring-2 focus:ring-accent/20 rounded-2xl px-4 py-3 text-base lg:text-[14px] text-ink placeholder:text-muted outline-none resize-none transition-colors overflow-y-auto"
            />

            {/* Enviar */}
            <button
              onClick={handleSend}
              disabled={(!inputText.trim() && !imageBase64) || isLoading}
              className="shrink-0 w-12 h-12 grid place-items-center rounded-2xl bg-accent text-on-accent hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Enviar"
            >
              <svg className="w-5 h-5 -ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
