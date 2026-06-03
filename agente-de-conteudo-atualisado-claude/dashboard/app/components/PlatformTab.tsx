"use client";

import type { DailyReport } from "@/app/lib/types";
import type { PlatformDef } from "@/app/lib/platformExperts";
import ClaudeImprovements from "./ClaudeImprovements";
import VideoCard from "./VideoCard";
import SpecButtons from "./SpecButtons";
import { platformToMarkdown } from "@/app/lib/specExport";

export default function PlatformTab({ def, report }: { def: PlatformDef; report: DailyReport }) {
  const improvements = (report.claude_improvements ?? []).filter((imp) =>
    (imp.sources ?? []).some((s) => def.dataKeys.includes(s.platform))
  );
  const topics = (report.topic_summaries ?? []).filter((t) => def.dataKeys.includes(t.platform));
  const videos = def.id === "youtube" ? report.youtube_insights ?? [] : [];

  const hasData = improvements.length > 0 || topics.length > 0 || videos.length > 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Cabeçalho da plataforma + download */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-[#2a2a2a] bg-[#111111] px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center text-sm font-bold text-white">
            {def.emoji}
          </span>
          <div>
            <h2 className="text-base font-bold text-[#f5f5f5]">{def.label}</h2>
            <p className="text-xs text-[#6b6b6b]">{def.blurb}</p>
          </div>
        </div>
        <SpecButtons
          getText={() => platformToMarkdown(def.label, improvements, [], topics)}
          filename={`${def.id}-claude-${report.analysis_date || report.id.slice(0, 8)}`}
          label="Baixar MD"
        />
      </div>

      {/* Especialistas / contas monitoradas */}
      <section>
        <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-2">
          Especialistas & contas monitoradas
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {def.experts.map((e) => (
            <a
              key={e.url}
              href={e.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl border border-[#2a2a2a] bg-[#111111] p-3 card-hover group"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-[#f5f5f5] group-hover:text-white">{e.name}</span>
                <span className="text-[10px] text-[#6b6b6b]">{e.handle}</span>
              </div>
              <p className="text-xs text-[#a1a1a1] leading-relaxed mt-1">{e.note}</p>
              <span className="inline-block text-[10px] text-[#6b6b6b] group-hover:text-white mt-2 transition-colors">
                abrir ↗
              </span>
            </a>
          ))}
        </div>
      </section>

      {/* Resumo dos tópicos desta plataforma */}
      {topics.length > 0 && (
        <section>
          <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-2">
            Resumo dos tópicos
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {topics.map((t, i) => (
              <div key={i} className="rounded-2xl border border-[#2a2a2a] bg-[#111111] p-4">
                <h3 className="text-xs font-bold text-[#f5f5f5] mb-1.5">{t.topic}</h3>
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
                  <a href={t.url} target="_blank" rel="noopener noreferrer" className="inline-block text-[10px] text-[#6b6b6b] hover:text-white mt-2">
                    ver fonte ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Vídeos (só YouTube) */}
      {videos.length > 0 && (
        <section>
          <p className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider mb-2">
            Vídeos analisados
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {videos.map((v, i) => (
              <VideoCard key={v.videoId || i} insight={v} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* Melhorias do Claude vindas desta plataforma (com "como implementar" por agente) */}
      {improvements.length > 0 && <ClaudeImprovements items={improvements} />}

      {/* Estado vazio */}
      {!hasData && (
        <div className="rounded-2xl border border-dashed border-[#2a2a2a] bg-[#0d0d0d] p-8 text-center">
          <p className="text-sm text-[#a1a1a1] mb-1">Sem conteúdo capturado desta plataforma neste relatório.</p>
          <p className="text-xs text-[#6b6b6b]">
            {def.id === "youtube" || def.id === "forums"
              ? "Será populado no próximo ciclo do agente."
              : "Configure FIRECRAWL_API_KEY para o agente coletar desta plataforma automaticamente."}
          </p>
        </div>
      )}
    </div>
  );
}
