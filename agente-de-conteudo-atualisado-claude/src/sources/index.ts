/**
 * Agregador de fontes — junta Reddit + Google + LinkedIn num único SourceItem[].
 * YouTube e GitHub continuam em src/agents/ (têm pipeline próprio de análise por item).
 */
import { SourceItem } from "./types"
import { fetchRedditItems } from "./reddit"
import { fetchGoogleItems, fetchLinkedInItems, fetchTwitterItems, fetchInstagramItems } from "./firecrawl"
import { ENABLE_REDDIT } from "../config/sources"

export type { SourceItem, SourcePlatform } from "./types"

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [Sources] ${message}`)
}

/** Busca todas as fontes web em paralelo. Cada uma é tolerante a falha. */
export async function gatherWebSources(): Promise<SourceItem[]> {
  const tasks: Promise<SourceItem[]>[] = [
    ENABLE_REDDIT ? fetchRedditItems() : Promise.resolve([]),
    fetchGoogleItems(),
    fetchLinkedInItems(),
    fetchTwitterItems(),
    fetchInstagramItems(),
  ]

  const settled = await Promise.allSettled(tasks)
  const items: SourceItem[] = []
  for (const r of settled) {
    if (r.status === "fulfilled") items.push(...r.value)
    else log(`Fonte falhou (não-fatal): ${r.reason}`)
  }

  const byPlatform = items.reduce<Record<string, number>>((acc, it) => {
    acc[it.platform] = (acc[it.platform] ?? 0) + 1
    return acc
  }, {})
  log(`Total de itens web: ${items.length} ${JSON.stringify(byPlatform)}`)
  return items
}
