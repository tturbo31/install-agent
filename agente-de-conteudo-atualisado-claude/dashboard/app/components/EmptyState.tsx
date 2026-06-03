"use client";

import { useEffect, useState } from "react";

export default function EmptyState() {
  const [dots, setDots] = useState("");

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 600);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] px-4 animate-fade-in">
      {/* Animated clock */}
      <div className="relative mb-8">
        <div className="w-24 h-24 rounded-full border-2 border-[#2a2a2a] bg-[#111111] flex items-center justify-center animate-pulse-glow">
          <svg
            className="w-12 h-12 text-[#ffffff] animate-spin-slow"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              strokeWidth="1.5"
              className="opacity-30"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 6v6l4 2"
            />
          </svg>
        </div>
        {/* Orbit dot */}
        <div className="absolute inset-0 animate-spin" style={{ animationDuration: "3s" }}>
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-[#8a8a8a]" />
        </div>
      </div>

      {/* Title */}
      <h2 className="text-2xl font-bold text-[#f5f5f5] mb-3 text-center">
        Nenhum relatório ainda{dots}
      </h2>

      {/* Subtitle */}
      <p className="text-sm text-[#6b6b6b] text-center max-w-sm leading-relaxed mb-8">
        O agente Camo Intelligence roda diariamente às{" "}
        <span className="text-[#ffffff] font-semibold">8:00 (Brasília)</span>. Os relatórios
        aparecerão aqui automaticamente após a primeira execução.
      </p>

      {/* Schedule card */}
      <div className="bg-[#111111] border border-[#2a2a2a] rounded-2xl p-5 max-w-sm w-full">
        <p className="text-xs font-semibold text-[#6b6b6b] uppercase tracking-wider mb-3">
          O que esperar
        </p>
        <ul className="space-y-3">
          {[
            { icon: "🎬", text: "Análise de vídeos do YouTube e insights" },
            { icon: "⚡", text: "Descoberta e avaliação de projetos do GitHub" },
            { icon: "📋", text: "Guia de implementação acionável" },
            { icon: "🎯", text: "Checklist diário de ações prioritárias" },
          ].map((item, i) => (
            <li key={i} className="flex items-center gap-3 text-sm text-[#a1a1a1]">
              <span className="text-base">{item.icon}</span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Next run indicator */}
      <div className="mt-6 flex items-center gap-2 text-xs text-[#6b6b6b]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#ffffff] animate-pulse" />
        Agente agendado — próxima execução às 8:00 (Brasília)
      </div>
    </div>
  );
}
