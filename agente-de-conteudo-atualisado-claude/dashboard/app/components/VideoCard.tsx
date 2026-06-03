"use client";

import { useState } from "react";
import Image from "next/image";
import type { YouTubeInsight } from "@/app/lib/types";
import SpecButtons from "./SpecButtons";

interface VideoCardProps {
  insight: YouTubeInsight;
  index: number;
}

type Tab = "overview" | "analysis" | "implement";

const PRIORITY_COLORS = {
  high: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20", label: "ALTA" },
  medium: { bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/20", label: "MÉDIA" },
  low: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20", label: "BAIXA" },
};

function MarkdownText({ text }: { text: string }) {
  if (!text) return null;

  const lines = text.split("\n");
  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        if (line.startsWith("## ")) {
          return (
            <h3 key={i} className="text-sm font-bold text-[#8a8a8a] mt-4 mb-1 first:mt-0">
              {line.replace(/^## /, "")}
            </h3>
          );
        }
        if (line.startsWith("# ")) {
          return (
            <h2 key={i} className="text-sm font-bold text-[#ffffff] mt-4 mb-1 first:mt-0">
              {line.replace(/^# /, "")}
            </h2>
          );
        }
        if (line.startsWith("**") && line.endsWith("**")) {
          return (
            <p key={i} className="text-xs font-semibold text-[#e0e0e0]">
              {line.replace(/\*\*/g, "")}
            </p>
          );
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <li key={i} className="text-xs text-[#a1a1a1] leading-relaxed ml-3 flex gap-2">
              <span className="text-[#ffffff] shrink-0 mt-0.5">•</span>
              <span>{line.replace(/^[-*] /, "")}</span>
            </li>
          );
        }
        if (line.trim() === "") return <div key={i} className="h-1" />;
        return (
          <p key={i} className="text-xs text-[#a1a1a1] leading-relaxed">
            {line}
          </p>
        );
      })}
    </div>
  );
}

export default function VideoCard({ insight, index }: VideoCardProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [imgError, setImgError] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);
  const [showDemos, setShowDemos] = useState(false);
  const [showTips, setShowTips] = useState(false);

  const thumbnailUrl = imgError
    ? `https://img.youtube.com/vi/${insight.videoId}/hqdefault.jpg`
    : `https://img.youtube.com/vi/${insight.videoId}/maxresdefault.jpg`;

  const priority = PRIORITY_COLORS[insight.priorityLevel ?? "medium"];

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "overview", label: "Visão Geral", icon: "◎" },
    { id: "analysis", label: "Análise Completa", icon: "◈" },
    { id: "implement", label: "Como Implementar", icon: "◆" },
  ];

  return (
    <div
      className="group relative rounded-2xl border border-[#2a2a2a] bg-[#111111] overflow-hidden animate-fade-in-up flex flex-col"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Top gradient border */}
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[#ffffff] via-[#8a8a8a] to-[#ffffff]" />

      {/* Thumbnail */}
      <div className="relative aspect-video overflow-hidden bg-[#0d0d0d] shrink-0">
        <Image
          src={thumbnailUrl}
          alt={insight.title}
          fill
          className="object-cover transition-transform duration-500 group-hover:scale-105"
          onError={() => setImgError(true)}
          unoptimized
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <a
            href={insight.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center w-14 h-14 rounded-full bg-white shadow-lg shadow-white/25 hover:bg-[#e5e5e5] transition-colors"
          >
            <svg className="w-6 h-6 text-black ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </a>
        </div>
        <div className="absolute top-2 left-2 bg-black/70 text-[#8a8a8a] text-xs font-bold px-2 py-0.5 rounded-md backdrop-blur-sm">
          #{index + 1}
        </div>
        {insight.priorityLevel && (
          <div className={`absolute top-2 right-2 text-[10px] font-bold px-2 py-0.5 rounded-md backdrop-blur-sm border ${priority.bg} ${priority.text} ${priority.border}`}>
            {priority.label}
          </div>
        )}
      </div>

      {/* Title */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        <a
          href={insight.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-sm font-semibold text-[#f5f5f5] leading-snug hover:text-[#ffffff] transition-colors line-clamp-2"
        >
          {insight.title}
        </a>
        <p className="text-xs text-[#6b6b6b] leading-relaxed mt-1.5 line-clamp-2">
          {insight.summary}
        </p>
      </div>

      {/* Tabs */}
      <div className="px-4 shrink-0">
        <div className="flex gap-1 border-b border-[#1f1f1f]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1 px-3 py-2 text-[10px] font-semibold transition-all duration-150 border-b-2 -mb-px ${
                activeTab === tab.id
                  ? "text-[#ffffff] border-[#ffffff]"
                  : "text-[#555] border-transparent hover:text-[#a1a1a1]"
              }`}
            >
              <span className="text-[11px]">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 py-3 flex-1 overflow-y-auto" style={{ maxHeight: "360px" }}>

        {/* TAB: Visão Geral */}
        {activeTab === "overview" && (
          <div className="space-y-2">
            {/* Key Features */}
            {insight.keyFeatures?.length > 0 && (
              <div>
                <button
                  onClick={() => setShowFeatures(!showFeatures)}
                  className="w-full flex items-center justify-between text-xs font-medium text-[#a1a1a1] hover:text-[#ffffff] transition-colors py-1.5 border-b border-[#1f1f1f]"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#ffffff]" />
                    Recursos Demonstrados ({insight.keyFeatures.length})
                  </span>
                  <svg className={`w-3.5 h-3.5 transition-transform ${showFeatures ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showFeatures && (
                  <div className="pt-2 pb-1 flex flex-wrap gap-1.5">
                    {insight.keyFeatures.map((f, i) => (
                      <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/10 text-[#e5e5e5] border border-white/20">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Visual Demonstrations */}
            {insight.visualDemonstrations?.length > 0 && (
              <div>
                <button
                  onClick={() => setShowDemos(!showDemos)}
                  className="w-full flex items-center justify-between text-xs font-medium text-[#a1a1a1] hover:text-[#8a8a8a] transition-colors py-1.5 border-b border-[#1f1f1f]"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#8a8a8a]" />
                    Demonstrações ({insight.visualDemonstrations.length})
                  </span>
                  <svg className={`w-3.5 h-3.5 transition-transform ${showDemos ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showDemos && (
                  <ul className="pt-2 pb-1 space-y-1">
                    {insight.visualDemonstrations.map((d, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-[#a1a1a1]">
                        <span className="text-[#8a8a8a] mt-0.5 shrink-0">▶</span>
                        <span className="leading-relaxed">{d}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Tips */}
            {insight.implementationTips?.length > 0 && (
              <div>
                <button
                  onClick={() => setShowTips(!showTips)}
                  className="w-full flex items-center justify-between text-xs font-medium text-[#a1a1a1] hover:text-emerald-400 transition-colors py-1.5"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Dicas ({insight.implementationTips.length})
                  </span>
                  <svg className={`w-3.5 h-3.5 transition-transform ${showTips ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showTips && (
                  <ul className="pt-2 pb-1 space-y-1.5">
                    {insight.implementationTips.map((tip, i) => (
                      <li key={i} className="text-xs text-[#a1a1a1] bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg p-2 leading-relaxed font-mono">
                        <span className="text-emerald-400 mr-1.5">//</span>
                        {tip}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Improvements */}
            {insight.improvements?.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#1f1f1f]">
                <p className="text-[10px] font-semibold text-[#555] uppercase tracking-wider mb-2">Melhorias Proporcionadas</p>
                <ul className="space-y-1">
                  {insight.improvements.map((imp, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-[#a1a1a1]">
                      <span className="text-[#ffffff] shrink-0 mt-0.5">↑</span>
                      <span className="leading-relaxed">{imp}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* TAB: Análise Completa */}
        {activeTab === "analysis" && (
          <div>
            {insight.fullAnalysis ? (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-[#555] uppercase tracking-wider mb-3">
                  Análise detalhada gerada pelo Claude a partir da transcrição completa
                </p>
                <MarkdownText text={insight.fullAnalysis} />
              </div>
            ) : (
              <p className="text-xs text-[#555] italic">Análise completa não disponível para este vídeo.</p>
            )}
          </div>
        )}

        {/* TAB: Como Implementar */}
        {activeTab === "implement" && (
          <div>
            {insight.implementationForOurSystem ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <p className="text-[10px] font-semibold text-[#555] uppercase tracking-wider">
                    Como aplicar no nosso sistema de agente de conteúdo
                  </p>
                  <SpecButtons
                    size="sm"
                    getText={() => `# Implementar (vídeo): ${insight.title}\n${insight.url}\n\n${insight.implementationForOurSystem}`}
                    filename={`implementar-video-${(insight.videoId || "video")}`}
                  />
                </div>
                <MarkdownText text={insight.implementationForOurSystem} />
              </div>
            ) : (
              <div>
                <p className="text-[10px] font-semibold text-[#555] uppercase tracking-wider mb-3">
                  Dicas de implementação
                </p>
                {insight.implementationTips?.length > 0 ? (
                  <ul className="space-y-2">
                    {insight.implementationTips.map((tip, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-[#a1a1a1] bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg p-2.5 leading-relaxed">
                        <span className="text-[#ffffff] font-bold shrink-0">{i + 1}.</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-[#555] italic">Guia de implementação não disponível para este vídeo.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Watch button */}
      <div className="px-4 pb-4 pt-2 shrink-0 border-t border-[#1a1a1a]">
        <a
          href={insight.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full py-2 rounded-xl text-xs font-semibold bg-[#ffffff]/10 text-[#ffffff] border border-[#ffffff]/20 hover:bg-[#ffffff]/20 hover:border-[#ffffff]/40 transition-all duration-150 active:scale-95"
        >
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
          Assistir no YouTube
        </a>
      </div>
    </div>
  );
}
