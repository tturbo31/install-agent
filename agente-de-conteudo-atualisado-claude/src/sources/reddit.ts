/**
 * Reddit source — grátis, via feeds RSS/Atom públicos.
 * (Os endpoints .json do Reddit retornam HTTP 403 para acesso programático;
 *  os feeds /.rss continuam abertos — por isso usamos RSS aqui.)
 * Foca em posts recentes relevantes a Claude / Anthropic / MCP / APIs de agentes.
 */
import { SourceItem, truncate } from "./types"
import { REDDIT_SUBREDDITS, MAX_ITEMS_PER_SOURCE, SOURCE_DAYS_BACK } from "../config/sources"

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [RedditSource] ${message}`)
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
const KEYWORDS = ["claude", "anthropic", "mcp", "agent", "api", "sdk", "opus", "sonnet", "haiku"]

interface RedditEntry {
  title: string
  url: string
  author: string
  publishedAt: string
  content: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))
  return m ? m[1].trim() : ""
}

/** Parser simples de Atom (formato dos feeds do Reddit). */
function parseAtom(xml: string): RedditEntry[] {
  const entries: RedditEntry[] = []
  const blocks = xml.split(/<entry[\s>]/i).slice(1)
  for (const b of blocks) {
    const linkMatch = b.match(/<link[^>]*href="([^"]+)"/i)
    const authorBlock = b.match(/<author>([\s\S]*?)<\/author>/i)?.[1] ?? ""
    entries.push({
      title: stripHtml(tag(b, "title")),
      url: linkMatch ? decodeEntities(linkMatch[1]) : "",
      author: stripHtml(tag(authorBlock, "name")),
      publishedAt: tag(b, "published") || tag(b, "updated"),
      content: stripHtml(tag(b, "content")),
    })
  }
  return entries
}

async function fetchSubredditRSS(sub: string): Promise<RedditEntry[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/new/.rss?limit=25`
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/atom+xml" } })
  if (!res.ok) {
    log(`r/${sub} retornou HTTP ${res.status} — pulando.`)
    return []
  }
  return parseAtom(await res.text())
}

export async function fetchRedditItems(): Promise<SourceItem[]> {
  log(`Buscando ${REDDIT_SUBREDDITS.length} subreddit(s) via RSS: ${REDDIT_SUBREDDITS.join(", ")}`)
  const cutoff = Date.now() - SOURCE_DAYS_BACK * 86400_000
  const items: SourceItem[] = []

  for (const sub of REDDIT_SUBREDDITS) {
    try {
      const entries = await fetchSubredditRSS(sub)
      const relevant = entries
        .filter((e) => {
          const t = e.publishedAt ? new Date(e.publishedAt).getTime() : Date.now()
          return t >= cutoff
        })
        .filter((e) => {
          const hay = `${e.title} ${e.content}`.toLowerCase()
          return KEYWORDS.some((k) => hay.includes(k))
        })
        .slice(0, MAX_ITEMS_PER_SOURCE)

      for (const e of relevant) {
        items.push({
          platform: "reddit",
          title: e.title,
          url: e.url,
          content: truncate(`${e.title}\n\n${e.content}`, 1500),
          author: e.author,
          publishedAt: e.publishedAt || undefined,
          query: `r/${sub}`,
        })
      }
      log(`  r/${sub}: ${relevant.length} item(ns) relevante(s) (de ${entries.length} no feed).`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`  r/${sub} falhou (não-fatal): ${msg}`)
    }
  }

  log(`Reddit total: ${items.length} item(ns).`)
  return items
}
