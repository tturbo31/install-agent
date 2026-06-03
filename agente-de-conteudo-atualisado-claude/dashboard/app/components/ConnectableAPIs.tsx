"use client";

import type { ConnectableAPI } from "@/app/lib/types";

const AGENT_LABEL: Record<string, string> = {
  contentAgent: "Conteúdo",
  instagramDmAgent: "Instagram DM",
  camoSocialAgent: "Social Camo",
};

function APICard({ api, index }: { api: ConnectableAPI; index: number }) {
  return (
    <div
      className="rounded-2xl border border-[#2a2a2a] bg-[#111111] p-4 card-hover animate-fade-in-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-bold text-[#f5f5f5]">{api.name}</h3>
        {api.docsUrl ? (
          <a
            href={api.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-[#6b6b6b] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-full px-2 py-0.5 transition-colors"
          >
            docs ↗
          </a>
        ) : null}
      </div>

      <p className="text-xs text-[#a1a1a1] leading-relaxed mb-2">{api.whatItIs}</p>

      <div className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-xl p-3 mb-2">
        <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-1">Caso de uso</p>
        <p className="text-xs text-[#a1a1a1] leading-relaxed">{api.useCase}</p>
      </div>

      <div className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-xl p-3 mb-2">
        <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-1">Como conectar ao Claude</p>
        <p className="text-xs text-[#a1a1a1] leading-relaxed whitespace-pre-line">{api.howToConnect}</p>
      </div>

      {api.benefits?.length > 0 && (
        <ul className="space-y-1 mb-2">
          {api.benefits.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-[#a1a1a1]">
              <span className="text-white shrink-0 mt-0.5">+</span>
              <span className="leading-relaxed">{b}</span>
            </li>
          ))}
        </ul>
      )}

      {api.appliesTo?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {api.appliesTo.map((a, i) => (
            <span
              key={i}
              className="text-[10px] text-[#8a8a8a] bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-0.5 rounded-full"
            >
              {AGENT_LABEL[a] ?? a}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ConnectableAPIs({ items }: { items: ConnectableAPI[] }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 11-5.656-5.656l1.5-1.5m6.328-1.328a4 4 0 010-5.656l3-3a4 4 0 115.656 5.656l-1.5 1.5" />
        </svg>
        <h2 className="text-sm font-bold text-[#f5f5f5]">APIs conectáveis ao Claude</h2>
        <span className="ml-auto text-[10px] text-[#6b6b6b] bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-0.5 rounded-full">
          {items.length} API{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((api, i) => (
          <APICard key={api.name || i} api={api} index={i} />
        ))}
      </div>
    </section>
  );
}
