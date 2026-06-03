"use client";

import { useState } from "react";
import { downloadMarkdown, copyToClipboard } from "@/app/lib/specExport";

interface SpecButtonsProps {
  /** Gera o texto markdown a exportar (lazy — só roda no clique). */
  getText: () => string;
  filename: string;
  /** "lg" = botões da barra principal; "sm" = botão compacto em card. */
  size?: "lg" | "sm";
  label?: string;
}

export default function SpecButtons({ getText, filename, size = "lg", label }: SpecButtonsProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyToClipboard(getText());
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  if (size === "sm") {
    return (
      <button
        onClick={handleCopy}
        className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6b6b6b] hover:text-white border border-[#2a2a2a] hover:border-white/30 rounded-lg px-2 py-1 transition-colors"
        title="Copiar especificação para colar no Claude"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        {copied ? "Copiado!" : label ?? "Copiar p/ Claude"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleCopy}
        className="inline-flex items-center gap-1.5 text-xs font-semibold bg-white text-black hover:bg-[#e5e5e5] rounded-lg px-3 py-1.5 transition-colors active:scale-95"
        title="Copiar todas as especificações para colar no Claude"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        {copied ? "Copiado!" : label ?? "Copiar p/ Claude"}
      </button>
      <button
        onClick={() => downloadMarkdown(filename, getText())}
        className="inline-flex items-center gap-1.5 text-xs font-semibold bg-[#1a1a1a] text-[#e5e5e5] border border-[#2a2a2a] hover:border-[#3a3a3a] hover:text-white rounded-lg px-3 py-1.5 transition-colors active:scale-95"
        title="Baixar especificações em .md"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        Baixar .md
      </button>
    </div>
  );
}
