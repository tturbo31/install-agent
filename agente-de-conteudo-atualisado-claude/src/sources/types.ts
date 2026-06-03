/**
 * Camada de fontes (multi-source scraping).
 * Tudo que é raspado de Reddit, Google, LinkedIn e web é normalizado para SourceItem,
 * para o analyzer tratar todas as fontes de forma uniforme.
 */

export type SourcePlatform = "reddit" | "google" | "linkedin" | "twitter" | "instagram" | "web"

export interface SourceItem {
  platform: SourcePlatform
  title: string
  url: string
  /** Texto/markdown já truncado, pronto para ir ao prompt. */
  content: string
  author?: string
  /** ISO date, quando disponível. */
  publishedAt?: string
  /** Upvotes / engajamento, quando disponível. */
  score?: number
  /** A query de busca ou subreddit que encontrou este item (rastreabilidade). */
  query?: string
}

/** Limita o tamanho do conteúdo que vai para o prompt (controle de custo). */
export function truncate(text: string, max = 1500): string {
  if (!text) return ""
  const t = text.replace(/\s+\n/g, "\n").trim()
  return t.length > max ? t.slice(0, max) + "…" : t
}
