import { createClient } from "@supabase/supabase-js";
import type { DailyReport, ReportHistoryItem } from "./types";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

/**
 * Desembrulha os campos novos quando o relatório foi salvo sem as colunas próprias
 * (fallback embutido em implementation_guide via sentinela CAMO_EXTRA_V1).
 * Funciona com ou sem a migration aplicada.
 */
export function hydrateReport(report: DailyReport | null): DailyReport | null {
  if (!report) return report;
  const hasNative =
    (report.claude_improvements?.length ?? 0) > 0 ||
    (report.connectable_apis?.length ?? 0) > 0 ||
    (report.topic_summaries?.length ?? 0) > 0;
  const guide = report.implementation_guide ?? "";
  const m = guide.match(/<!--CAMO_EXTRA_V1:([\s\S]*?)-->/);
  if (!m) return report;

  // Remove a sentinela do guia exibido.
  report.implementation_guide = guide.replace(m[0], "").trim();
  if (hasNative) return report; // já veio das colunas próprias

  try {
    const extra = JSON.parse(decodeURIComponent(m[1]));
    report.claude_improvements = extra.claudeImprovements ?? [];
    report.connectable_apis = extra.connectableAPIs ?? [];
    report.topic_summaries = extra.topicSummaries ?? [];
  } catch {
    // ignora payload inválido
  }
  return report;
}

export async function getLatestReport(): Promise<DailyReport | null> {
  const { data, error } = await supabase
    .from("daily_reports")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // No rows returned
      return null;
    }
    console.error("Error fetching latest report:", error);
    return null;
  }

  return hydrateReport(data as DailyReport);
}

export async function getReportById(id: string): Promise<DailyReport | null> {
  const { data, error } = await supabase
    .from("daily_reports")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("Error fetching report by id:", error);
    return null;
  }

  return hydrateReport(data as DailyReport);
}

export async function getReportHistory(): Promise<ReportHistoryItem[]> {
  const { data, error } = await supabase
    .from("daily_reports")
    .select("id, created_at, analysis_date, run_number, executive_summary")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    console.error("Error fetching report history:", error);
    return [];
  }

  return (data as ReportHistoryItem[]) ?? [];
}
