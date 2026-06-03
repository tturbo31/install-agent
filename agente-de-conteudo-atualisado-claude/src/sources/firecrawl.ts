/**
 * Firecrawl source — Google SERP, LinkedIn e web em Markdown limpo (LLM-ready).
 * Tudo gated por FIRECRAWL_API_KEY. Sem key, as funções retornam [] e logam (sem quebrar).
 * Docs: https://docs.firecrawl.dev (endpoint /v1/search com scrapeOptions markdown).
 */
import { SourceItem, SourcePlatform, truncate } from "./types"
import {
  FIRECRAWL_API_KEY,
  ENABLE_GOOGLE,
  ENABLE_LINKEDIN,
  ENABLE_TWITTER,
  ENABLE_INSTAGRAM,
  SEARCH_QUERIES,
  MAX_ITEMS_PER_SOURCE,
} from "../config/sources"

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [FirecrawlSource] ${message}`)
}

interface FirecrawlSearchResult {
  url: string
  title?: string
  description?: string
  markdown?: string
}

/** Chama o endpoint /v1/search do Firecrawl. Retorna [] em qualquer falha. */
async function firecrawlSearch(query: string, limit: number): Promise<FirecrawlSearchResult[]> {
  if (!FIRECRAWL_API_KEY) return []
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit,
        scrapeOptions: { formats: ["markdown"] },
      }),
    })
    if (!res.ok) {
      log(`Busca "${query}" retornou HTTP ${res.status} — pulando.`)
      return []
    }
    const json = (await res.json()) as { success?: boolean; data?: FirecrawlSearchResult[] }
    return json.data ?? []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Busca "${query}" falhou (não-fatal): ${msg}`)
    return []
  }
}

async function searchToItems(
  queries: string[],
  platform: SourcePlatform,
  suffix = ""
): Promise<SourceItem[]> {
  const items: SourceItem[] = []
  const seen = new Set<string>()
  for (const q of queries) {
    const fullQuery = suffix ? `${q} ${suffix}` : q
    const results = await firecrawlSearch(fullQuery, MAX_ITEMS_PER_SOURCE)
    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue
      seen.add(r.url)
      items.push({
        platform,
        title: r.title || r.url,
        url: r.url,
        content: truncate(r.markdown || r.description || "", 1800),
        query: fullQuery,
      })
    }
    log(`  "${fullQuery}" → ${results.length} resultado(s).`)
  }
  return items
}

/** Google SERP focado em melhorias do Claude + APIs conectáveis. */
export async function fetchGoogleItems(): Promise<SourceItem[]> {
  if (!ENABLE_GOOGLE) {
    log("Google desligado (sem FIRECRAWL_API_KEY ou ENABLE_GOOGLE=false).")
    return []
  }
  log(`Google: ${SEARCH_QUERIES.length} query(s).`)
  const items = await searchToItems(SEARCH_QUERIES, "google")
  log(`Google total: ${items.length} item(ns).`)
  return items
}

/** LinkedIn — posts públicos via busca restrita ao domínio. */
export async function fetchLinkedInItems(): Promise<SourceItem[]> {
  if (!ENABLE_LINKEDIN) {
    log("LinkedIn desligado (sem FIRECRAWL_API_KEY ou ENABLE_LINKEDIN=false).")
    return []
  }
  log(`LinkedIn: ${SEARCH_QUERIES.length} query(s).`)
  const items = await searchToItems(SEARCH_QUERIES, "linkedin", "site:linkedin.com/posts")
  log(`LinkedIn total: ${items.length} item(ns).`)
  return items
}

/** Twitter/X — posts públicos via busca restrita ao domínio. */
export async function fetchTwitterItems(): Promise<SourceItem[]> {
  if (!ENABLE_TWITTER) {
    log("Twitter/X desligado (sem FIRECRAWL_API_KEY ou ENABLE_TWITTER=false).")
    return []
  }
  log(`Twitter/X: ${SEARCH_QUERIES.length} query(s).`)
  const items = await searchToItems(SEARCH_QUERIES, "twitter", "(site:x.com OR site:twitter.com)")
  log(`Twitter/X total: ${items.length} item(ns).`)
  return items
}

/** Instagram — posts públicos via busca restrita ao domínio. */
export async function fetchInstagramItems(): Promise<SourceItem[]> {
  if (!ENABLE_INSTAGRAM) {
    log("Instagram desligado (sem FIRECRAWL_API_KEY ou ENABLE_INSTAGRAM=false).")
    return []
  }
  log(`Instagram: ${SEARCH_QUERIES.length} query(s).`)
  const items = await searchToItems(SEARCH_QUERIES, "instagram", "site:instagram.com")
  log(`Instagram total: ${items.length} item(ns).`)
  return items
}
