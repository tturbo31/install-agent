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
      <span className="text-xs text-gray-500 px-1">IA</span>
      <div className="bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-3 flex gap-1.5 items-center">
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:300ms]" />
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
        <span className="text-xs text-gray-500 px-1">Cliente</span>
        <div className="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    );
  }

  // Assistant bubble
  const borderClass =
    msg.status === "corrected"
      ? "border border-red-500"
      : "border border-transparent";

  return (
    <div className="flex flex-col items-start gap-1 animate-fade-in">
      <span className="text-xs text-gray-500 px-1">IA</span>

      {/* Original AI bubble */}
      <div
        className={`bg-gray-800 text-white rounded-2xl rounded-tl-sm px-4 py-2.5 max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap break-words ${borderClass}`}
      >
        {msg.status === "corrected" && (
          <p className="text-red-400 text-xs font-semibold mb-1">Resposta incorreta</p>
        )}
        {msg.content}
      </div>

      {/* Action buttons — only shown while pending */}
      {msg.status === "pending" && sandboxId && (
        <div className="flex gap-2 ml-1">
          <button
            onClick={() => onMarkGood(msg.id)}
            className="flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-950 hover:bg-green-900 border border-green-800 px-3 py-1.5 rounded-full transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Boa resposta
          </button>
          <button
            onClick={() => onStartCorrect(msg.id)}
            className="flex items-center gap-1.5 text-xs font-medium text-yellow-400 bg-yellow-950 hover:bg-yellow-900 border border-yellow-800 px-3 py-1.5 rounded-full transition-colors"
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
        <div className="w-full max-w-[75%] mt-1 ml-1 space-y-2">
          <textarea
            ref={textareaRef}
            value={correctionText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCorrectionText(e.target.value)}
            placeholder="Como deveria ter respondido?"
            rows={3}
            className="w-full bg-gray-800 border border-yellow-700 focus:border-yellow-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none resize-none transition-colors"
          />
          <div className="flex gap-2">
            <button
              onClick={() => onCancelCorrect(msg.id)}
              className="text-xs font-medium text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-1.5 rounded-full transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={!correctionText.trim() || isSaving}
              className="text-xs font-medium text-white bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 rounded-full transition-colors"
            >
              {isSaving ? "Salvando..." : "Salvar correção"}
            </button>
          </div>
        </div>
      )}

      {/* Corrected replacement bubble */}
      {msg.status === "corrected" && msg.correctedContent && (
        <div className="flex flex-col items-start gap-1 mt-1">
          <div className="bg-green-950 border border-green-700 text-green-200 rounded-2xl rounded-tl-sm px-4 py-2.5 max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap break-words">
            <p className="text-green-400 text-xs font-semibold mb-1">Correcao salva</p>
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
        headers: { "Content-Type": "application/json" },
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

    await fetch("/api/training/chat", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sandboxId,
        aiMsgId: msg.aiMsgId,
        correction,
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
    <div className="flex flex-col h-full bg-gray-950 text-white">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-gray-800 bg-gray-900">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-900 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-indigo-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.63 48.63 0 0112 20.904a48.63 48.63 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white leading-tight">Simulador de IA</h2>
            <p className="text-xs text-gray-500 leading-tight mt-0.5">
              Escreva como cliente &bull; A IA responde como no direto &bull; Corrija quando errar
            </p>
          </div>
        </div>
        <button
          onClick={handleNewSession}
          className="flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          Nova sessao
        </button>
      </div>

      {/* Message area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !isLoading ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full gap-5 text-center">
            <div className="w-16 h-16 rounded-2xl bg-indigo-900 flex items-center justify-center">
              <svg className="w-8 h-8 text-indigo-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-white">Simule uma conversa de cliente</p>
              <p className="text-sm text-gray-500 mt-1 max-w-xs">
                A IA vai responder exatamente como faria no Instagram ou WhatsApp
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 max-w-sm">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInputText(s)}
                  className="text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 rounded-full transition-colors"
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

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-gray-800 bg-gray-900 px-4 pt-3 pb-4">
        {/* Image preview */}
        {imagePreview && (
          <div className="mb-2 flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imagePreview}
              alt="Preview"
              className="h-14 w-14 object-cover rounded-lg border border-gray-700"
            />
            <button
              onClick={handleRemoveImage}
              className="text-gray-400 hover:text-red-400 transition-colors"
              aria-label="Remove image"
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
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Attach image"
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

          {/* Text input */}
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Escreva como um cliente..."
            rows={1}
            style={{ fontSize: "16px" }}
            className="flex-1 bg-gray-800 border border-gray-700 focus:border-blue-600 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none resize-none transition-colors max-h-40 overflow-y-auto"
          />

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={(!inputText.trim() && !imageBase64) || isLoading}
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Send"
          >
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>

        <p className="text-xs text-gray-600 mt-2 text-center">
          Enter para enviar &bull; Shift+Enter para nova linha
        </p>
      </div>
    </div>
  );
}
