/**
 * Exporta as especificações de um relatório (ou de uma melhoria) em Markdown,
 * pronto para COLAR NO CLAUDE (Claude Code) e mandar implementar nos projetos.
 */
import type {
  DailyReport,
  ClaudeImprovement,
  ConnectableAPI,
  YouTubeInsight,
  GitHubProjectAnalysis,
} from "./types";

const AGENT_LABEL: Record<string, string> = {
  contentAgent: "Agente de Conteúdo (agente-de-conteudo-atualisado-claude)",
  instagramDmAgent: "Agente de DM do Instagram (instagram-dm-agent)",
  camoSocialAgent: "Agente de Social Media da Camo (frontend-tturbo)",
};

function improvementBlock(imp: ClaudeImprovement): string {
  const benefits = (imp.benefits ?? []).map((b) => `- ${b}`).join("\n");
  const sources = (imp.sources ?? [])
    .map((s) => `- [${s.platform}] ${s.title} — ${s.url}`)
    .join("\n");
  const byAgent = imp.implementationByAgent
    ? Object.entries(imp.implementationByAgent)
        .map(([k, v]) => `#### ${AGENT_LABEL[k] ?? k}\n${v}`)
        .join("\n\n")
    : "";
  return `### ${imp.title}  \`[${imp.category}]\` (prioridade: ${imp.priority})

**O que é:** ${imp.whatItIs}

**O que faz:** ${imp.whatItDoes}

**Benefícios:**
${benefits || "- —"}

**Como implementar (geral):**
${imp.howToImplement || "—"}

**Como implementar em cada agente:**

${byAgent}

${sources ? `**Fontes:**\n${sources}` : ""}`.trim();
}

function apiBlock(api: ConnectableAPI): string {
  const benefits = (api.benefits ?? []).map((b) => `- ${b}`).join("\n");
  return `### ${api.name}

**O que é:** ${api.whatItIs}
**Caso de uso:** ${api.useCase}
**Como conectar ao Claude:** ${api.howToConnect}
**Aplica-se a:** ${(api.appliesTo ?? []).join(", ") || "—"}
${api.docsUrl ? `**Docs:** ${api.docsUrl}` : ""}

**Benefícios:**
${benefits || "- —"}`.trim();
}

function videoBlock(v: YouTubeInsight): string {
  return `### 🎬 ${v.title}
${v.url}

${v.implementationForOurSystem || v.summary || ""}`.trim();
}

function repoBlock(r: GitHubProjectAnalysis): string {
  return `### 💻 ${r.name} (${r.stars}★)
${r.url}

${r.implementationForOurSystem || r.whatItDoes || ""}`.trim();
}

/** Especificação completa do relatório, pronta para colar no Claude. */
export function reportToMarkdown(report: DailyReport): string {
  const date = report.analysis_date || report.created_at;
  const parts: string[] = [];

  parts.push(`# Especificações para implementar no Claude — ${date}

> Cole isto no Claude Code e peça para implementar nos projetos indicados.
> Agentes-alvo: Agente de Conteúdo, Agente de DM do Instagram, Agente de Social Media da Camo.`);

  if (report.executive_summary) {
    parts.push(`## Resumo executivo\n${report.executive_summary}`);
  }

  if (report.claude_improvements?.length) {
    parts.push(
      `## 🔥 Melhorias do Claude (${report.claude_improvements.length})\n\n` +
        report.claude_improvements.map(improvementBlock).join("\n\n---\n\n")
    );
  }

  if (report.connectable_apis?.length) {
    parts.push(
      `## 🔌 APIs conectáveis ao Claude (${report.connectable_apis.length})\n\n` +
        report.connectable_apis.map(apiBlock).join("\n\n---\n\n")
    );
  }

  if (report.priority_actions?.length) {
    parts.push(
      `## ✅ Ações prioritárias\n` +
        report.priority_actions.map((a, i) => `${i + 1}. ${a}`).join("\n")
    );
  }

  if (report.youtube_insights?.length) {
    parts.push(
      `## YouTube — como implementar\n\n` +
        report.youtube_insights.map(videoBlock).join("\n\n")
    );
  }

  if (report.github_projects?.length) {
    parts.push(
      `## GitHub — como implementar\n\n` +
        report.github_projects.map(repoBlock).join("\n\n")
    );
  }

  if (report.implementation_guide) {
    parts.push(`## Guia de implementação\n${report.implementation_guide}`);
  }

  return parts.join("\n\n");
}

/** Especificação de UMA melhoria, pronta para colar no Claude. */
export function improvementToMarkdown(imp: ClaudeImprovement): string {
  return `# Implementar no Claude: ${imp.title}\n\n${improvementBlock(imp)}`;
}

/** Especificações de UMA plataforma (aba), pronta para colar no Claude. */
export function platformToMarkdown(
  label: string,
  improvements: ClaudeImprovement[],
  apis: ConnectableAPI[],
  topics: { topic: string; summary: string; takeaways: string[]; url?: string }[]
): string {
  const parts: string[] = [`# ${label} — melhorias do Claude e como implementar`];
  if (topics.length) {
    parts.push(
      `## Resumo dos tópicos\n\n` +
        topics
          .map(
            (t) =>
              `### ${t.topic}\n${t.summary}\n${(t.takeaways ?? [])
                .map((k) => `- ${k}`)
                .join("\n")}${t.url ? `\nFonte: ${t.url}` : ""}`
          )
          .join("\n\n")
    );
  }
  if (improvements.length) {
    parts.push(
      `## Melhorias do Claude (${improvements.length})\n\n` +
        improvements.map(improvementBlock).join("\n\n---\n\n")
    );
  }
  if (apis.length) {
    parts.push(
      `## APIs conectáveis (${apis.length})\n\n` + apis.map(apiBlock).join("\n\n---\n\n")
    );
  }
  if (parts.length === 1) parts.push("_Sem conteúdo capturado desta plataforma neste relatório._");
  return parts.join("\n\n");
}

/** Dispara o download de um texto como arquivo .md. */
export function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".md") ? filename : `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Copia texto para a área de transferência (com fallback). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}
