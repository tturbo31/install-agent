import Anthropic from "@anthropic-ai/sdk"
import type { AnalysisResult } from "./claude-analyzer"

let _anthropic: Anthropic | null = null
function getClient(apiKey: string): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey })
  return _anthropic
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [AgentMemory] ${msg}`)
}

// ---- Types ----

export interface AgentMemory {
  analyzedVideoIds: string[]        // YouTube video IDs already processed
  analyzedRepoUrls: string[]        // GitHub repo URLs already analyzed
  learnedPatterns: string[]         // Key Claude Code patterns discovered over time
  implementationHistory: string[]   // Past recommendations (to avoid repetition)
  topicsMap: Record<string, number> // Topic → how many times seen (tracks focus areas)
  totalRunsCompleted: number
  lastRunDate: string
}

// ---- Memory store lifecycle ----

export async function initializeMemoryStore(apiKey: string, existingStoreId?: string): Promise<string> {
  const client = getClient(apiKey)

  if (existingStoreId) {
    log(`Using existing memory store: ${existingStoreId}`)
    return existingStoreId
  }

  log("Creating new memory store for content agent...")
  const store = await client.beta.memoryStores.create({
    name: "claude-content-agent",
    description: "Auto-learning memory for the Claude Code daily intelligence agent. Tracks what was already analyzed and accumulates knowledge over time.",
  })

  // Bootstrap all memory files
  await Promise.all([
    client.beta.memoryStores.memories.create(store.id, {
      path: "/analyzed-videos.md",
      content: buildAnalyzedVideosContent([]),
    }),
    client.beta.memoryStores.memories.create(store.id, {
      path: "/analyzed-repos.md",
      content: buildAnalyzedReposContent([]),
    }),
    client.beta.memoryStores.memories.create(store.id, {
      path: "/learned-knowledge.md",
      content: buildLearnedKnowledgeContent([], []),
    }),
    client.beta.memoryStores.memories.create(store.id, {
      path: "/agent-stats.md",
      content: buildStatsContent(0, "", {}),
    }),
  ])

  log(`Memory store created: ${store.id}`)
  log("IMPORTANT: Save this ID as MEMORY_STORE_ID in your .env file to persist memory across runs.")
  console.log(`\n  MEMORY_STORE_ID=${store.id}\n`)

  return store.id
}

// ---- Read memory ----

export async function readAgentMemory(apiKey: string, storeId: string): Promise<AgentMemory> {
  const client = getClient(apiKey)
  log(`Reading memory from store ${storeId}...`)

  try {
    const page = await client.beta.memoryStores.memories.list(storeId, { path_prefix: "/" })
    const memItems = page.data.filter((m) => m.type === "memory")

    const contents: Record<string, string> = {}
    await Promise.all(
      memItems.map(async (m) => {
        const item = m as { id: string; path?: string }
        const full = await client.beta.memoryStores.memories.retrieve(item.id, {
          memory_store_id: storeId,
        })
        const content = (full as { content?: string }).content ?? ""
        if (item.path) contents[item.path] = content
      })
    )

    return parseMemoryContents(contents)
  } catch (err) {
    log(`Memory read failed, using empty state: ${err instanceof Error ? err.message : String(err)}`)
    return emptyMemory()
  }
}

// ---- Update memory after a run ----

export async function updateAgentMemory(
  apiKey: string,
  storeId: string,
  previousMemory: AgentMemory,
  newVideoIds: string[],
  newRepoUrls: string[],
  analysis: AnalysisResult
): Promise<void> {
  const client = getClient(apiKey)
  log("Saving new knowledge to memory store...")

  // Merge new items into existing lists (deduplicated)
  const allVideoIds = [...new Set([...previousMemory.analyzedVideoIds, ...newVideoIds])]
  const allRepoUrls = [...new Set([...previousMemory.analyzedRepoUrls, ...newRepoUrls])]

  // Extract new patterns from analysis
  const newPatterns = extractPatternsFromAnalysis(analysis)
  const allPatterns = [...new Set([...previousMemory.learnedPatterns, ...newPatterns])].slice(0, 150)

  // Track implementation history (keep last 50)
  const newHistory = [
    ...analysis.priorityActions.slice(0, 3).map((a) => `[${new Date().toDateString()}] ${a}`),
    ...previousMemory.implementationHistory,
  ].slice(0, 50)

  // Update topics map
  const updatedTopics = { ...previousMemory.topicsMap }
  for (const insight of analysis.youtubeInsights) {
    for (const feature of insight.keyFeatures) {
      const key = feature.toLowerCase().trim().slice(0, 60)
      updatedTopics[key] = (updatedTopics[key] ?? 0) + 1
    }
  }
  for (const proj of analysis.githubProjects) {
    const key = proj.name.toLowerCase().trim()
    updatedTopics[key] = (updatedTopics[key] ?? 0) + 1
  }

  const totalRuns = previousMemory.totalRunsCompleted + 1

  // Fetch current memory file IDs
  const page = await client.beta.memoryStores.memories.list(storeId, { path_prefix: "/" })
  const byPath: Record<string, string> = {}
  for (const m of page.data.filter((m) => m.type === "memory")) {
    const item = m as { id: string; path?: string }
    if (item.path) byPath[item.path] = item.id
  }

  const updates: Array<{ path: string; content: string }> = [
    { path: "/analyzed-videos.md", content: buildAnalyzedVideosContent(allVideoIds) },
    { path: "/analyzed-repos.md", content: buildAnalyzedReposContent(allRepoUrls) },
    { path: "/learned-knowledge.md", content: buildLearnedKnowledgeContent(allPatterns, newHistory) },
    { path: "/agent-stats.md", content: buildStatsContent(totalRuns, new Date().toISOString(), updatedTopics) },
  ]

  await Promise.all(
    updates.map(async ({ path, content }) => {
      const memId = byPath[path]
      if (memId) {
        await client.beta.memoryStores.memories.update(memId, {
          memory_store_id: storeId,
          content,
        })
      } else {
        await client.beta.memoryStores.memories.create(storeId, { path, content })
      }
    })
  )

  log(`Memory updated. Total runs: ${totalRuns}. Known videos: ${allVideoIds.length}. Known repos: ${allRepoUrls.length}. Patterns learned: ${allPatterns.length}.`)
}

// ---- Build memory context string for Claude prompt ----

export function buildMemoryContext(memory: AgentMemory): string {
  if (memory.totalRunsCompleted === 0) {
    return "This is the agent's first run. No prior knowledge exists yet."
  }

  const topTopics = Object.entries(memory.topicsMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([topic, count]) => `  - ${topic} (seen ${count}x)`)
    .join("\n")

  const recentHistory = memory.implementationHistory.slice(0, 10).join("\n  - ")

  return `## Agent Prior Knowledge (${memory.totalRunsCompleted} runs completed)

### Already Analyzed Content (SKIP THESE — they were processed in previous runs)
- Videos processed: ${memory.analyzedVideoIds.length} videos already in memory
- Repos processed: ${memory.analyzedRepoUrls.length} repos already in memory

### Top Topics Learned So Far
${topTopics || "  (none yet)"}

### Accumulated Claude Code Patterns
${memory.learnedPatterns.slice(0, 30).map((p) => `  - ${p}`).join("\n") || "  (none yet)"}

### Recent Past Recommendations (avoid repeating these)
  - ${recentHistory || "(none yet)"}

### Instruction
Build on this prior knowledge. Do NOT re-explain things already in the patterns list. Focus on what is NEW and DIFFERENT from what was already learned. If today's content confirms or extends a known pattern, note that progression rather than repeating the basics.`
}

// ---- Dreaming: weekly memory consolidation ----

/**
 * "Dreaming" is the process of reorganizing the memory store after N runs.
 * It reads all accumulated knowledge, asks Claude to deduplicate, enrich and
 * create a clean index, then writes the result to a NEW memory store so the
 * original is never destroyed.  The new store ID is returned so the caller
 * can persist it to .env.
 *
 * Mirrors what `anthropic.beta.dreams` will do natively once the SDK ships it.
 */
export async function runDreaming(
  apiKey: string,
  currentStoreId: string,
  currentMemory: AgentMemory
): Promise<string> {
  const client = getClient(apiKey)
  log("=== DREAMING: Memory Consolidation Starting ===")
  log(`Source store: ${currentStoreId}`)

  // 1. Read all raw content from the current store
  const page = await client.beta.memoryStores.memories.list(currentStoreId, { path_prefix: "/" })
  const memItems = page.data.filter((m) => m.type === "memory")

  const rawFiles: Record<string, string> = {}
  await Promise.all(
    memItems.map(async (m) => {
      const item = m as { id: string; path?: string }
      const full = await client.beta.memoryStores.memories.retrieve(item.id, {
        memory_store_id: currentStoreId,
      })
      const content = (full as { content?: string }).content ?? ""
      if (item.path) rawFiles[item.path] = content
    })
  )

  log(`Read ${Object.keys(rawFiles).length} memory files. Asking Claude to consolidate...`)

  // 2. Ask Claude to reorganize and enrich all content
  const consolidationPrompt = `You are a memory consolidation agent. You have access to a content intelligence agent's accumulated knowledge base after ${currentMemory.totalRunsCompleted} daily runs.

Your job:
1. DEDUPLICATE: Remove repeated or near-duplicate patterns and insights
2. ENRICH: Add context or connections between related items where obvious
3. ORGANIZE: Group patterns by theme (e.g., "Model Context Protocol", "Agent Architecture", "Memory Systems", "Tooling")
4. CREATE INDEX: Write a concise /index.md with the key topics and what's in each file
5. KEEP ALL VIDEO IDs AND REPO URLs: Never remove those — they prevent re-analysis

Here is the full memory store content:

${Object.entries(rawFiles).map(([path, content]) => `### FILE: ${path}\n${content}`).join("\n\n---\n\n")}

Respond with ONLY a JSON object with this exact shape (no markdown, no explanation):
{
  "index": "string — /index.md content with organized topic index",
  "analyzedVideos": "string — cleaned /analyzed-videos.md content (keep ALL IDs)",
  "analyzedRepos": "string — cleaned /analyzed-repos.md content (keep ALL URLs)",
  "learnedKnowledge": "string — reorganized /learned-knowledge.md with deduplication and grouping",
  "stats": "string — updated /agent-stats.md content"
}`

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    messages: [{ role: "user", content: consolidationPrompt }],
  })

  const rawText = response.content[0].type === "text" ? response.content[0].text : ""
  let organized: {
    index: string
    analyzedVideos: string
    analyzedRepos: string
    learnedKnowledge: string
    stats: string
  }

  try {
    organized = JSON.parse(rawText)
  } catch {
    log("WARNING: Claude returned invalid JSON for dreaming. Aborting dreaming, keeping original store.")
    return currentStoreId
  }

  // 3. Create a new (clean) memory store for the dreamed output
  log("Creating new 'dreamed' memory store...")
  const newStore = await client.beta.memoryStores.create({
    name: "claude-content-agent",
    description: `Dreamed (consolidated) memory store. Source: ${currentStoreId}. Runs completed: ${currentMemory.totalRunsCompleted}. Dreamed on: ${new Date().toISOString()}`,
  })

  // 4. Write all reorganized files to the new store
  await Promise.all([
    client.beta.memoryStores.memories.create(newStore.id, {
      path: "/index.md",
      content: organized.index,
    }),
    client.beta.memoryStores.memories.create(newStore.id, {
      path: "/analyzed-videos.md",
      content: organized.analyzedVideos,
    }),
    client.beta.memoryStores.memories.create(newStore.id, {
      path: "/analyzed-repos.md",
      content: organized.analyzedRepos,
    }),
    client.beta.memoryStores.memories.create(newStore.id, {
      path: "/learned-knowledge.md",
      content: organized.learnedKnowledge,
    }),
    client.beta.memoryStores.memories.create(newStore.id, {
      path: "/agent-stats.md",
      content: organized.stats,
    }),
  ])

  log(`=== DREAMING COMPLETE ===`)
  log(`New (dreamed) store: ${newStore.id}`)
  log(`Original store preserved: ${currentStoreId}`)

  return newStore.id
}

/**
 * Updates the MEMORY_STORE_ID in the .env file with the dreamed store ID.
 * Called automatically after runDreaming() returns a new store ID.
 */
export async function swapMemoryStoreInEnv(
  envFilePath: string,
  oldStoreId: string,
  newStoreId: string
): Promise<void> {
  const fs = await import("fs")
  const content = fs.readFileSync(envFilePath, "utf-8")
  const updated = content.replace(
    /^MEMORY_STORE_ID=.*$/m,
    `MEMORY_STORE_ID=${newStoreId}`
  )
  fs.writeFileSync(envFilePath, updated, "utf-8")
  log(`MEMORY_STORE_ID updated in .env: ${oldStoreId} → ${newStoreId}`)
}

/**
 * Returns true if today is Sunday — used to gate weekly dreaming.
 * Also returns true if the agent has run >= 7 times since last dream
 * (fallback for daily-only deployments).
 */
export function shouldRunDreaming(totalRuns: number): boolean {
  const dayOfWeek = new Date().getDay() // 0 = Sunday
  if (dayOfWeek === 0) return true
  if (totalRuns > 0 && totalRuns % 7 === 0) return true
  return false
}

// ---- Helpers ----

function emptyMemory(): AgentMemory {
  return {
    analyzedVideoIds: [],
    analyzedRepoUrls: [],
    learnedPatterns: [],
    implementationHistory: [],
    topicsMap: {},
    totalRunsCompleted: 0,
    lastRunDate: "",
  }
}

function extractPatternsFromAnalysis(analysis: AnalysisResult): string[] {
  const patterns: string[] = []

  for (const insight of analysis.youtubeInsights) {
    for (const tip of insight.implementationTips.slice(0, 3)) {
      if (tip.length > 20 && tip.length < 200) patterns.push(tip)
    }
    for (const feat of insight.keyFeatures.slice(0, 3)) {
      if (feat.length > 10 && feat.length < 120) patterns.push(feat)
    }
  }

  for (const proj of analysis.githubProjects) {
    if (proj.worthImplementing) {
      for (const imp of proj.improvements.slice(0, 2)) {
        if (imp.length > 20 && imp.length < 200) patterns.push(imp)
      }
    }
  }

  // Extract key sentences from the implementation guide
  const sentences = analysis.implementationGuide
    .split(/[.!?]\s+/)
    .filter((s) => s.length > 40 && s.length < 180)
    .slice(0, 5)
  patterns.push(...sentences)

  return [...new Set(patterns)]
}

function parseMemoryContents(contents: Record<string, string>): AgentMemory {
  const memory = emptyMemory()

  // Parse analyzed videos
  const videosContent = contents["/analyzed-videos.md"] ?? ""
  const videoMatches = videosContent.match(/^- (.+)$/gm) ?? []
  memory.analyzedVideoIds = videoMatches.map((l) => l.replace(/^- /, "").trim())

  // Parse analyzed repos
  const reposContent = contents["/analyzed-repos.md"] ?? ""
  const repoMatches = reposContent.match(/^- (.+)$/gm) ?? []
  memory.analyzedRepoUrls = repoMatches.map((l) => l.replace(/^- /, "").trim())

  // Parse learned knowledge
  const knowledgeContent = contents["/learned-knowledge.md"] ?? ""
  const patternSection = knowledgeContent.split("## Implementation History")[0] ?? ""
  const patternMatches = patternSection.match(/^- (.+)$/gm) ?? []
  memory.learnedPatterns = patternMatches.map((l) => l.replace(/^- /, "").trim())

  const historySection = knowledgeContent.split("## Implementation History")[1] ?? ""
  const historyMatches = historySection.match(/^- (.+)$/gm) ?? []
  memory.implementationHistory = historyMatches.map((l) => l.replace(/^- /, "").trim())

  // Parse stats
  const statsContent = contents["/agent-stats.md"] ?? ""
  const runsMatch = statsContent.match(/Total runs: (\d+)/)
  if (runsMatch) memory.totalRunsCompleted = parseInt(runsMatch[1], 10)

  const lastRunMatch = statsContent.match(/Last run: (.+)/)
  if (lastRunMatch) memory.lastRunDate = lastRunMatch[1].trim()

  // Parse topics map
  const topicsSection = statsContent.split("## Topics")[1] ?? ""
  const topicMatches = topicsSection.match(/^- (.+): (\d+)$/gm) ?? []
  for (const line of topicMatches) {
    const m = line.match(/^- (.+): (\d+)$/)
    if (m) memory.topicsMap[m[1]] = parseInt(m[2], 10)
  }

  return memory
}

// ---- Content builders ----

function buildAnalyzedVideosContent(videoIds: string[]): string {
  const lines = ["# Analyzed YouTube Videos", "", "Videos already processed by this agent:", ""]
  for (const id of videoIds) lines.push(`- ${id}`)
  lines.push(``, `Updated: ${new Date().toISOString()}`)
  return lines.join("\n")
}

function buildAnalyzedReposContent(repoUrls: string[]): string {
  const lines = ["# Analyzed GitHub Repositories", "", "Repos already processed by this agent:", ""]
  for (const url of repoUrls) lines.push(`- ${url}`)
  lines.push(``, `Updated: ${new Date().toISOString()}`)
  return lines.join("\n")
}

function buildLearnedKnowledgeContent(patterns: string[], history: string[]): string {
  const lines = [
    "# Accumulated Knowledge Base",
    "",
    "## Claude Code Patterns Learned",
    "",
    ...patterns.map((p) => `- ${p}`),
    "",
    "## Implementation History",
    "",
    ...history.map((h) => `- ${h}`),
    "",
    `Updated: ${new Date().toISOString()}`,
  ]
  return lines.join("\n")
}

function buildStatsContent(
  totalRuns: number,
  lastRunDate: string,
  topicsMap: Record<string, number>
): string {
  const topTopics = Object.entries(topicsMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)

  const lines = [
    "# Agent Statistics",
    "",
    `Total runs: ${totalRuns}`,
    `Last run: ${lastRunDate}`,
    "",
    "## Topics",
    "",
    ...topTopics.map(([topic, count]) => `- ${topic}: ${count}`),
    "",
    `Updated: ${new Date().toISOString()}`,
  ]
  return lines.join("\n")
}
