/**
 * Configuração das fontes de scraping (Reddit, Google, LinkedIn, web).
 * Tudo sobrescrevível por env. Sem FIRECRAWL_API_KEY, Google/LinkedIn/web desligam
 * automaticamente sem quebrar o resto (YouTube + GitHub + Reddit continuam de graça).
 */

function envStr(name: string, fallback: string): string {
  const v = process.env[name]?.trim()
  return v && v.length > 0 ? v : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  if (v === undefined || v === "") return fallback
  return v === "true" || v === "1" || v === "yes"
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]?.trim())
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name]?.trim()
  if (!v) return fallback
  return v.split(",").map((s) => s.trim()).filter(Boolean)
}

/** Key do Firecrawl — desbloqueia Google SERP, LinkedIn e web. */
export const FIRECRAWL_API_KEY = envStr("FIRECRAWL_API_KEY", "")

export const ENABLE_REDDIT = envBool("ENABLE_REDDIT", true)
export const ENABLE_GOOGLE = envBool("ENABLE_GOOGLE", FIRECRAWL_API_KEY.length > 0)
export const ENABLE_LINKEDIN = envBool("ENABLE_LINKEDIN", FIRECRAWL_API_KEY.length > 0)
export const ENABLE_TWITTER = envBool("ENABLE_TWITTER", FIRECRAWL_API_KEY.length > 0)
export const ENABLE_INSTAGRAM = envBool("ENABLE_INSTAGRAM", FIRECRAWL_API_KEY.length > 0)

/** Subreddits monitorados (foco em Claude, Anthropic e APIs de IA). */
export const REDDIT_SUBREDDITS = envList("REDDIT_SUBREDDITS", [
  "ClaudeAI",
  "Anthropic",
  "LocalLLaMA",
  "AI_Agents",
])

/**
 * Queries de busca (Google/LinkedIn) — focadas no que o usuário pediu:
 * melhorias no Claude + APIs conectáveis ao Claude.
 */
export const SEARCH_QUERIES = envList("SEARCH_QUERIES", [
  "new Claude API features",
  "Claude Code new features update",
  "Anthropic MCP servers new",
  "APIs to connect with Claude AI agents",
  "Claude agent SDK improvements",
])

/** Itens máximos por fonte (controle de custo/tempo). */
export const MAX_ITEMS_PER_SOURCE = envNum("MAX_ITEMS_PER_SOURCE", 6)

/** Janela de frescor em dias para considerar um item "recente". */
export const SOURCE_DAYS_BACK = envNum("SOURCE_DAYS_BACK", 7)
