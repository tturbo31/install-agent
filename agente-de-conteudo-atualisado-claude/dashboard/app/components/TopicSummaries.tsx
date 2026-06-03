"use client";

import { useState } from "react";
import type { TopicSummary } from "@/app/lib/types";

const PLATFORM_META: Record<string, { label: string; icon: string }> = {
  youtube: { label: "YouTube", icon: "▶" },
  github: { label: "GitHub", icon: "" },
  reddit: { label: "Reddit", icon: "" },
  google: { label: "Google", icon: "G" },
  linkedin: { label: "LinkedIn", icon: "in" },
  web: { label: "Web", icon: "" },
};

const PLATFORMS = ["all", "youtube", "github", "reddit", "google", "linkedin", "web"] as const;

export default function TopicSummaries({ items }: { items: TopicSummary[] }) {
  const [filter, setFilter] = useState<string>("all");
  if (!items?.length) return null;

  const present = new Set(items.map((i) => i.platform));
  const tabs = PLATFORMS.filter((p) => p === "all" || present.has(p));
  const filtered = filter === "all" ? items : items.filter((i) => i.platform === filter);

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 6h16M4 12h16M4 18h10" />
        </svg>
        <h2 className="text-sm font-bold text-[#f5f5f5]">Resumo dos tópicos por plataforma</h2>
        <span className="ml-auto text-[10px] text-[#6b6b6b] bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-0.5 rounded-full">
          {items.length} tópico{items.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Filtro por plataforma */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {tabs.map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
              filter === p
                ? "bg-white/10 text-white border-white/25"
                : "bg-[#111111] text-[#6b6b6b] border-[#2a2a2a] hover:text-[#a1a1a1]"
            }`}
          >
            {p === "all" ? "Todas" : PLATFORM_META[p]?.label ?? p}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filtered.map((t, i) => (
          <div
            key={i}
            className="rounded-2xl border border-[#2a2a2a] bg-[#111111] p-4 animate-fade-in-up"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wider text-[#8a8a8a] bg-[#1a1a1a] border border-[#2a2a2a] px-1.5 py-0.5 rounded">
                {PLATFORM_META[t.platform]?.label ?? t.platform}
              </span>
              <h3 className="text-xs font-bold text-[#f5f5f5] leading-snug">{t.topic}</h3>
            </div>
            <p className="text-xs text-[#a1a1a1] leading-relaxed mb-2">{t.summary}</p>
            {t.takeaways?.length > 0 && (
              <ul className="space-y-1">
                {t.takeaways.map((k, j) => (
                  <li key={j} className="flex items-start gap-2 text-[11px] text-[#8a8a8a]">
                    <span className="text-white shrink-0 mt-0.5">•</span>
                    <span className="leading-relaxed">{k}</span>
                  </li>
                ))}
              </ul>
            )}
            {t.url && (
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-[10px] text-[#6b6b6b] hover:text-white mt-2 transition-colors"
              >
                ver fonte ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
