"use client";

import { useState, useEffect } from "react";
import { format, parseISO } from "date-fns";
import { supabase, hydrateReport } from "@/app/lib/supabase";
import type { DailyReport, ReportHistoryItem } from "@/app/lib/types";
import ReportSidebar from "./ReportSidebar";
import StatsCard from "./StatsCard";
import VideoCard from "./VideoCard";
import GitHubCard from "./GitHubCard";
import ImplementationGuide from "./ImplementationGuide";
import PriorityActions from "./PriorityActions";
import ClaudeImprovements from "./ClaudeImprovements";
import ConnectableAPIs from "./ConnectableAPIs";
import TopicSummaries from "./TopicSummaries";
import SpecButtons from "./SpecButtons";
import PlatformTab from "./PlatformTab";
import { PLATFORMS } from "@/app/lib/platformExperts";
import { reportToMarkdown } from "@/app/lib/specExport";
import EmptyState from "./EmptyState";

const TABS = [{ id: "overview", label: "Visão Geral", emoji: "◎" }, ...PLATFORMS];

interface DashboardClientProps {
  initialReport: DailyReport | null;
  initialHistory: ReportHistoryItem[];
}

function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "EEEE, MMMM d, yyyy");
  } catch {
    return dateStr;
  }
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-[#111111] p-4 animate-pulse">
      <div className="h-3 bg-[#1f1f1f] rounded-lg w-2/3 mb-3" />
      <div className="h-5 bg-[#1f1f1f] rounded-lg w-1/3 mb-2" />
      <div className="h-3 bg-[#1f1f1f] rounded-lg w-full" />
    </div>
  );
}

function TopBar({ report }: { report: DailyReport }) {
  return (
    <header className="sticky top-0 z-30 bg-[#0a0a0a]/90 backdrop-blur-md border-b border-[#1f1f1f]">
      <div className="flex items-center gap-4 px-4 lg:px-6 h-14">
        {/* Logo / Brand */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#111111] border border-[#2a2a2a] flex items-center justify-center shadow-lg shadow-white/10">
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176A7.547 7.547 0 016.648 6.61a.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.811 2.133 1.001a5.99 5.99 0 011.925-3.547 3.75 3.75 0 013.255 3.718z" />
            </svg>
          </div>
          <div className="hidden sm:block">
            <span className="text-sm font-bold text-[#f5f5f5]">Camo</span>
            <span className="text-sm text-[#6b6b6b] ml-1.5">Intelligence</span>
          </div>
        </div>

        {/* Divider */}
        <div className="hidden sm:block w-px h-5 bg-[#2a2a2a]" />

        {/* Date */}
        <p className="hidden sm:block text-xs text-[#6b6b6b]">
          {formatDate(report.analysis_date || report.created_at)}
        </p>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Run badge */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#ffffff]/10 text-[#ffffff] border border-[#ffffff]/20">
            <span className="w-1.5 h-1.5 rounded-full bg-[#ffffff] animate-pulse" />
            Run #{report.run_number}
          </span>
        </div>
      </div>
    </header>
  );
}

export default function DashboardClient({
  initialReport,
  initialHistory,
}: DashboardClientProps) {
  const [activeReport, setActiveReport] = useState<DailyReport | null>(initialReport);
  const [history] = useState<ReportHistoryItem[]>(initialHistory);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("overview");

  const activeId = activeReport?.id ?? null;

  async function handleSelectReport(id: string) {
    if (id === activeId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("daily_reports")
      .select("*")
      .eq("id", id)
      .single();

    if (!error && data) {
      setActiveReport(hydrateReport(data as DailyReport));
    }
    setLoading(false);
  }

  if (!activeReport && !initialReport) {
    return (
      <div className="flex flex-col min-h-screen">
        <header className="sticky top-0 z-30 bg-[#0a0a0a]/90 backdrop-blur-md border-b border-[#1f1f1f]">
          <div className="flex items-center gap-2.5 px-4 lg:px-6 h-14">
            <div className="w-7 h-7 rounded-lg bg-[#111111] border border-[#2a2a2a] flex items-center justify-center shadow-lg shadow-white/10">
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176A7.547 7.547 0 016.648 6.61a.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.811 2.133 1.001a5.99 5.99 0 011.925-3.547 3.75 3.75 0 013.255 3.718z" />
              </svg>
            </div>
            <span className="text-sm font-bold text-[#f5f5f5]">Camo Intelligence</span>
          </div>
        </header>
        <EmptyState />
      </div>
    );
  }

  const report = activeReport!;

  const videoCount = report.youtube_insights?.length ?? 0;
  const githubCount = report.github_projects?.length ?? 0;
  const improvementsCount = report.claude_improvements?.length ?? 0;
  const apisCount = report.connectable_apis?.length ?? 0;
  const topicsCount = report.topic_summaries?.length ?? 0;

  return (
    <div className="flex flex-col min-h-screen">
      <TopBar report={report} />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <ReportSidebar
          history={history}
          activeId={activeId}
          onSelect={handleSelectReport}
        />

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          {/* Mobile date bar is rendered inside ReportSidebar */}

          {loading ? (
            <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
                {[...Array(4)].map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            </div>
          ) : (
            <div className="p-4 lg:p-6 space-y-6 animate-fade-in">

              {/* Navegação por plataforma */}
              <div className="flex items-center gap-1 overflow-x-auto border-b border-[#1f1f1f] -mx-4 px-4 lg:-mx-6 lg:px-6 scrollbar-hide">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`shrink-0 flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                      activeTab === t.id
                        ? "text-white border-white"
                        : "text-[#6b6b6b] border-transparent hover:text-[#a1a1a1]"
                    }`}
                  >
                    <span className="text-[11px]">{t.emoji}</span>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Aba de plataforma */}
              {activeTab !== "overview" &&
                (() => {
                  const def = PLATFORMS.find((p) => p.id === activeTab);
                  return def ? <PlatformTab def={def} report={report} /> : null;
                })()}

              {activeTab === "overview" && (
              <>
              {/* Barra de especificações para o Claude */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-[#2a2a2a] bg-[#111111] px-5 py-3 animate-fade-in-up">
                <div className="flex items-center gap-2.5">
                  <svg className="w-4 h-4 text-white shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176A7.547 7.547 0 016.648 6.61a.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.811 2.133 1.001a5.99 5.99 0 011.925-3.547 3.75 3.75 0 013.255 3.718z" />
                  </svg>
                  <div>
                    <p className="text-sm font-bold text-[#f5f5f5]">Especificações para o Claude</p>
                    <p className="text-xs text-[#6b6b6b]">Baixe ou copie tudo deste relatório pronto para colar no Claude Code.</p>
                  </div>
                </div>
                <SpecButtons
                  getText={() => reportToMarkdown(report)}
                  filename={`especificacoes-claude-${report.analysis_date || report.id.slice(0, 8)}`}
                />
              </div>

              {/* Executive Summary */}
              {report.executive_summary && (
                <div className="rounded-2xl border border-[#2a2a2a] bg-[#111111] px-5 py-4 animate-fade-in-up">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-1 h-4 rounded-full bg-gradient-to-b from-[#ffffff] to-[#8a8a8a]" />
                    <span className="text-xs font-semibold text-[#6b6b6b] uppercase tracking-wider">
                      Executive Summary
                    </span>
                  </div>
                  <p className="text-sm text-[#a1a1a1] leading-relaxed">
                    {report.executive_summary}
                  </p>
                </div>
              )}

              {/* Stats row */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
                <StatsCard
                  label="Melhorias do Claude"
                  value={improvementsCount}
                  icon={
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176A7.547 7.547 0 016.648 6.61a.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.811 2.133 1.001a5.99 5.99 0 011.925-3.547 3.75 3.75 0 013.255 3.718z" />
                    </svg>
                  }
                  description="Novas melhorias aplicáveis ao Claude"
                  gradient="orange"
                  delay={0}
                />
                <StatsCard
                  label="APIs conectáveis"
                  value={apisCount}
                  icon={
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 11-5.656-5.656l1.5-1.5m6.328-1.328a4 4 0 010-5.656l3-3a4 4 0 115.656 5.656l-1.5 1.5" />
                    </svg>
                  }
                  description="Serviços para plugar no Claude"
                  gradient="amber"
                  delay={100}
                />
                <StatsCard
                  label="Vídeos + Repos"
                  value={videoCount + githubCount}
                  icon={
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  }
                  description={`${videoCount} vídeos · ${githubCount} repos`}
                  gradient="green"
                  delay={200}
                />
                <StatsCard
                  label="Tópicos resumidos"
                  value={topicsCount}
                  icon={
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h10" />
                    </svg>
                  }
                  description="Reddit · Google · LinkedIn · YT · GitHub"
                  gradient="blue"
                  delay={300}
                />
              </div>

              {/* ⭐ Melhorias do Claude (foco principal) */}
              {improvementsCount > 0 && (
                <ClaudeImprovements items={report.claude_improvements!} />
              )}

              {/* ⭐ APIs conectáveis ao Claude */}
              {apisCount > 0 && (
                <ConnectableAPIs items={report.connectable_apis!} />
              )}

              {/* Two-column: Videos + GitHub */}
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                {/* YouTube — 40% (2/5) */}
                <div className="lg:col-span-2">
                  <div className="flex items-center gap-2 mb-3">
                    <svg className="w-4 h-4 text-[#ffffff]" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                    </svg>
                    <h2 className="text-sm font-bold text-[#f5f5f5]">YouTube Insights</h2>
                    <span className="ml-auto text-[10px] text-[#6b6b6b] bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-0.5 rounded-full">
                      {videoCount} videos
                    </span>
                  </div>

                  {videoCount > 0 ? (
                    <div className="space-y-4">
                      {report.youtube_insights.map((insight, i) => (
                        <VideoCard key={insight.videoId || i} insight={insight} index={i} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-[#2a2a2a] bg-[#111111] p-8 text-center text-[#6b6b6b] text-sm">
                      No YouTube insights in this report.
                    </div>
                  )}
                </div>

                {/* GitHub — 60% (3/5) */}
                <div className="lg:col-span-3">
                  <div className="flex items-center gap-2 mb-3">
                    <svg className="w-4 h-4 text-[#a1a1a1]" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    <h2 className="text-sm font-bold text-[#f5f5f5]">GitHub Projects</h2>
                    <span className="ml-auto text-[10px] text-[#6b6b6b] bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-0.5 rounded-full">
                      {githubCount} repos
                    </span>
                  </div>

                  {githubCount > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {report.github_projects.map((project, i) => (
                        <GitHubCard key={project.url || i} project={project} index={i} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-[#2a2a2a] bg-[#111111] p-8 text-center text-[#6b6b6b] text-sm">
                      No GitHub projects in this report.
                    </div>
                  )}
                </div>
              </div>

              {/* Resumo dos tópicos por plataforma */}
              {topicsCount > 0 && (
                <TopicSummaries items={report.topic_summaries!} />
              )}

              {/* Implementation Guide — full width */}
              {report.implementation_guide && (
                <ImplementationGuide content={report.implementation_guide} />
              )}

              {/* Priority Actions */}
              {report.priority_actions?.length > 0 && (
                <PriorityActions actions={report.priority_actions} />
              )}

              {/* Footer */}
              <div className="text-center py-4">
                <p className="text-xs text-[#3a3a3a]">
                  Camo Intelligence &mdash; Powered by Claude &mdash; Report ID:{" "}
                  <span className="font-mono">{report.id.slice(0, 8)}</span>
                </p>
              </div>
              </>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
