"use client";

import { useState } from "react";
import type { ClaudeImprovement } from "@/app/lib/types";
import SpecButtons from "./SpecButtons";
import { improvementToMarkdown } from "@/app/lib/specExport";

const PRIORITY = {
  high: { label: "ALTA", dot: "bg-white", text: "text-white", ring: "border-white/25" },
  medium: { label: "MÉDIA", dot: "bg-[#a1a1a1]", text: "text-[#d4d4d4]", ring: "border-white/15" },
  low: { label: "BAIXA", dot: "bg-[#6b6b6b]", text: "text-[#8a8a8a]", ring: "border-white/10" },
} as const;

const AGENTS = [
  { id: "contentAgent", label: "Agente de Conteúdo", icon: "📰" },
  { id: "instagramDmAgent", label: "Instagram DM", icon: "💬" },
  { id: "camoSocialAgent", label: "Social Media Camo", icon: "🔥" },
] as const;

type AgentId = (typeof AGENTS)[number]["id"];

function ImprovementCard({ item, index }: { item: ClaudeImprovement; index: number }) {
  const [agent, setAgent] = useState<AgentId>("contentAgent");
  const [open, setOpen] = useState(false);
  const prio = PRIORITY[item.priority] ?? PRIORITY.medium;

  return (
    <div
      className="rounded-2xl border border-[#2a2a2a] bg-[#111111] overflow-hidden card-hover animate-fade-in-up"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-white/60 to-transparent" />
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/10 text-[#e5e5e5] border border-white/15">
              {item.category}
            </span>
            <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold ${prio.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${prio.dot} animate-pulse`} />
              {prio.label}
            </span>
          </div>
          <SpecButtons size="sm" getText={() => improvementToMarkdown(item)} filename={`melhoria-${item.title}`} />
        </div>

        <h3 className="text-sm font-bold text-[#f5f5f5] leading-snug mb-2">{item.title}</h3>

        {/* O que é / O que faz */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          <div className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-xl p-3">
            <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-1">O que é</p>
            <p className="text-xs text-[#a1a1a1] leading-relaxed">{item.whatItIs}</p>
          </div>
          <div className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-xl p-3">
            <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-1">O que faz</p>
            <p className="text-xs text-[#a1a1a1] leading-relaxed">{item.whatItDoes}</p>
          </div>
        </div>

        {/* Benefícios */}
        {item.benefits?.length > 0 && (
          <div className="mb-3">
            <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-1.5">Benefícios</p>
            <ul className="space-y-1">
              {item.benefits.map((b, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-[#a1a1a1]">
                  <span className="text-white shrink-0 mt-0.5">↑</span>
                  <span className="leading-relaxed">{b}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Como implementar (geral) — colapsável */}
        {item.howToImplement && (
          <div className="mb-3">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center justify-between text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider hover:text-[#a1a1a1] transition-colors py-1 border-b border-[#1f1f1f]"
            >
              Como implementar (geral)
              <svg className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {open && <p className="text-xs text-[#a1a1a1] leading-relaxed mt-2 whitespace-pre-line">{item.howToImplement}</p>}
          </div>
        )}

        {/* Implementação por agente */}
        <div className="rounded-xl border border-[#1f1f1f] bg-[#0d0d0d] overflow-hidden">
          <div className="flex border-b border-[#1f1f1f]">
            {AGENTS.map((a) => (
              <button
                key={a.id}
                onClick={() => setAgent(a.id)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[10px] font-semibold transition-all border-b-2 -mb-px ${
                  agent === a.id ? "text-white border-white" : "text-[#555] border-transparent hover:text-[#a1a1a1]"
                }`}
              >
                <span>{a.icon}</span>
                <span className="hidden sm:inline">{a.label}</span>
              </button>
            ))}
          </div>
          <div className="p-3">
            <p className="text-[10px] font-semibold text-[#555] uppercase tracking-wider mb-1.5">
              Como implementar em: {AGENTS.find((a) => a.id === agent)?.label}
            </p>
            <p className="text-xs text-[#a1a1a1] leading-relaxed whitespace-pre-line">
              {item.implementationByAgent?.[agent] || "Guia não disponível para este agente."}
            </p>
          </div>
        </div>

        {/* Fontes */}
        {item.sources?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {item.sources.map((s, i) => (
              <a
                key={i}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-[#6b6b6b] bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-0.5 rounded-full hover:text-[#e5e5e5] hover:border-[#3a3a3a] transition-colors"
                title={s.title}
              >
                <span className="uppercase font-semibold">{s.platform}</span>
                <span className="opacity-50">·</span>
                <span className="max-w-[140px] truncate">{s.title}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClaudeImprovements({ items }: { items: ClaudeImprovement[] }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176A7.547 7.547 0 016.648 6.61a.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.811 2.133 1.001a5.99 5.99 0 011.925-3.547 3.75 3.75 0 013.255 3.718z" />
        </svg>
        <h2 className="text-sm font-bold text-[#f5f5f5]">Melhorias do Claude</h2>
        <span className="ml-auto text-[10px] text-[#6b6b6b] bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-0.5 rounded-full">
          {items.length} melhoria{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {items.map((item, i) => (
          <ImprovementCard key={item.title || i} item={item} index={i} />
        ))}
      </div>
    </section>
  );
}
