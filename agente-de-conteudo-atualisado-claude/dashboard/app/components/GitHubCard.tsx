"use client";

import { useState } from "react";
import type { GitHubProjectAnalysis } from "@/app/lib/types";

interface GitHubCardProps {
  project: GitHubProjectAnalysis;
  index: number;
}

type Tab = "overview" | "implement";

function MarkdownText({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        if (line.startsWith("## "))
          return <h3 key={i} className="text-xs font-bold text-[#f7c948] mt-3 mb-1 first:mt-0">{line.replace(/^## /, "")}</h3>;
        if (line.startsWith("# "))
          return <h2 key={i} className="text-xs font-bold text-[#ff6b35] mt-3 mb-1 first:mt-0">{line.replace(/^# /, "")}</h2>;
        if (line.startsWith("- ") || line.startsWith("* "))
          return (
            <li key={i} className="text-xs text-[#a1a1a1] leading-relaxed ml-3 flex gap-2">
              <span className="text-[#ff6b35] shrink-0 mt-0.5">•</span>
              <span>{line.replace(/^[-*] /, "")}</span>
            </li>
          );
        if (line.trim() === "") return <div key={i} className="h-1" />;
        return <p key={i} className="text-xs text-[#a1a1a1] leading-relaxed">{line}</p>;
      })}
    </div>
  );
}

const priorityConfig = {
  high: {
    label: "HIGH",
    bg: "bg-red-500/10",
    text: "text-red-400",
    border: "border-red-500/20",
    dot: "bg-red-500",
    glow: "shadow-red-500/10",
    topBorder: "from-red-500/60 to-red-500/20",
  },
  medium: {
    label: "MEDIUM",
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    border: "border-yellow-500/20",
    dot: "bg-yellow-500",
    glow: "shadow-yellow-500/10",
    topBorder: "from-yellow-500/60 to-yellow-500/20",
  },
  low: {
    label: "LOW",
    bg: "bg-[#2a2a2a]",
    text: "text-[#6b6b6b]",
    border: "border-[#2a2a2a]",
    dot: "bg-[#6b6b6b]",
    glow: "",
    topBorder: "from-[#2a2a2a] to-[#1f1f1f]",
  },
};

function SecurityScore({ score }: { score: number }) {
  const pct = Math.min(Math.max(score, 0), 10);
  const color =
    pct >= 7 ? "bg-emerald-500" : pct >= 4 ? "bg-yellow-500" : "bg-red-500";
  const label =
    pct >= 7 ? "text-emerald-400" : pct >= 4 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[#6b6b6b]">Security</span>
      <div className="flex-1 h-1.5 rounded-full bg-[#1f1f1f] overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all duration-700`}
          style={{ width: `${pct * 10}%` }}
        />
      </div>
      <span className={`text-xs font-bold ${label}`}>{pct}/10</span>
    </div>
  );
}

export default function GitHubCard({ project, index }: GitHubCardProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isWorth, setIsWorth] = useState(project.worthImplementing);
  const [showSteps, setShowSteps] = useState(false);
  const cfg = priorityConfig[project.priority];

  const repoName = project.name || project.url.split("/").slice(-2).join("/");

  return (
    <div
      className={`relative rounded-2xl border border-[#2a2a2a] bg-[#111111] overflow-hidden card-hover animate-fade-in-up shadow-lg ${cfg.glow}`}
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Priority top border */}
      <div className={`absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r ${cfg.topBorder}`} />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide ${cfg.bg} ${cfg.text} border ${cfg.border}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} animate-pulse`} />
                {cfg.label}
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] text-[#6b6b6b]">
                <svg className="w-3 h-3 text-[#f7c948]" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {project.stars?.toLocaleString() ?? "—"}
              </span>
            </div>
            <a
              href={project.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-[#f5f5f5] hover:text-[#ff6b35] transition-colors leading-snug line-clamp-1 block"
            >
              {repoName}
            </a>
          </div>
          <button
            onClick={() => setIsWorth(!isWorth)}
            className={`shrink-0 p-2 rounded-xl border transition-all duration-200 ${
              isWorth ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-[#1a1a1a] border-[#2a2a2a] text-[#6b6b6b] hover:text-[#a1a1a1]"
            }`}
            title="Toggle: worth implementing?"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isWorth ? "M5 13l4 4L19 7" : "M6 18L18 6M6 6l12 12"} />
            </svg>
          </button>
        </div>

        <p className="text-xs text-[#6b6b6b] leading-relaxed mb-3 line-clamp-2">{project.description}</p>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[#1f1f1f] mb-3">
          {(["overview", "implement"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold transition-all duration-150 border-b-2 -mb-px ${
                activeTab === tab ? "text-[#ff6b35] border-[#ff6b35]" : "text-[#555] border-transparent hover:text-[#a1a1a1]"
              }`}
            >
              {tab === "overview" ? "◎ Visão Geral" : "◆ Como Implementar"}
            </button>
          ))}
        </div>

        {/* TAB: Visão Geral */}
        {activeTab === "overview" && (
          <div className="space-y-3" style={{ minHeight: "160px" }}>
            {project.whatItDoes && (
              <div className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-xl p-3">
                <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-1">O que faz</p>
                <p className="text-xs text-[#a1a1a1] leading-relaxed">{project.whatItDoes}</p>
              </div>
            )}
            {project.improvements?.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-2">Melhorias</p>
                <ul className="space-y-1">
                  {project.improvements.slice(0, 3).map((imp, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-[#a1a1a1]">
                      <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="leading-relaxed">{imp}</span>
                    </li>
                  ))}
                  {project.improvements.length > 3 && (
                    <li className="text-xs text-[#6b6b6b] pl-5">+{project.improvements.length - 3} mais...</li>
                  )}
                </ul>
              </div>
            )}
            {project.howToImplement?.length > 0 && (
              <div>
                <button
                  onClick={() => setShowSteps(!showSteps)}
                  className="w-full flex items-center justify-between text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider hover:text-[#a1a1a1] transition-colors py-1 border-b border-[#1f1f1f]"
                >
                  Passos de implementação
                  <svg className={`w-3.5 h-3.5 transition-transform ${showSteps ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showSteps && (
                  <ol className="mt-2 space-y-1.5">
                    {project.howToImplement.map((step, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-[#a1a1a1]">
                        <span className="shrink-0 w-4 h-4 rounded-full bg-[#ff6b35]/10 text-[#ff6b35] text-[10px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <span className="leading-relaxed">{step}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
            {project.securityScore !== undefined && (
              <SecurityScore score={project.securityScore} />
            )}
          </div>
        )}

        {/* TAB: Como Implementar */}
        {activeTab === "implement" && (
          <div style={{ minHeight: "160px", maxHeight: "280px", overflowY: "auto" }}>
            {project.implementationForOurSystem ? (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-[#555] uppercase tracking-wider mb-3">
                  Como aplicar nos projetos reais
                </p>
                <MarkdownText text={project.implementationForOurSystem} />
              </div>
            ) : (
              <p className="text-xs text-[#555] italic">Guia de implementação não disponível para este repositório.</p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-3 pt-3 border-t border-[#1a1a1a]">
          <a
            href={project.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold bg-[#1a1a1a] text-[#a1a1a1] border border-[#2a2a2a] hover:bg-[#222] hover:text-[#f5f5f5] hover:border-[#3a3a3a] transition-all duration-150 active:scale-95"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            GitHub
          </a>
          <button
            onClick={() => setIsWorth(!isWorth)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border transition-all duration-150 active:scale-95 ${
              isWorth ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20" : "bg-[#1a1a1a] text-[#6b6b6b] border-[#2a2a2a] hover:text-[#a1a1a1]"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isWorth ? "M5 13l4 4L19 7" : "M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01"} />
            </svg>
            {isWorth ? "Vale a pena!" : "Avaliar?"}
          </button>
        </div>
      </div>
    </div>
  );
}
