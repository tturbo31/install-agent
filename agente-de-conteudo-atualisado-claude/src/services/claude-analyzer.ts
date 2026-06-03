import Anthropic from "@anthropic-ai/sdk"
import type { VideoData } from "../agents/youtube-agent"
import type { GitHubRepo } from "../agents/github-agent"
import type { SourceItem } from "../sources/types"
import {
  MODEL_DEEP,
  USE_BATCH_API,
  BATCH_MAX_WAIT_MS,
  BATCH_POLL_INTERVAL_MS,
  sleep,
} from "../config/models"

export interface YouTubeInsight {
  videoId: string
  title: string
  url: string
  summary: string
  fullAnalysis: string           // Complete detailed analysis of the video
  keyFeatures: string[]
  visualDemonstrations: string[]
  implementationTips: string[]
  implementationForOurSystem: string  // How to apply this in our agent system
  improvements: string[]         // What improvements/benefits this brings
  priorityLevel: "high" | "medium" | "low"
}

export interface GitHubProjectAnalysis {
  name: string
  url: string
  stars: number
  description: string
  whatItDoes: string
  improvements: string[]
  howToImplement: string[]
  implementationForOurSystem: string
  priority: "high" | "medium" | "low"
  worthImplementing: boolean
}

/** Implementação detalhada para cada um dos 3 agentes em produção. */
export interface ImplementationByAgent {
  contentAgent: string       // Agente de Conteúdo Diário (este repo)
  instagramDmAgent: string   // Agente de DM do Instagram (instagram-dm-agent)
  camoSocialAgent: string    // App/Agente de social media da Camo (frontend-tturbo)
}

/** Uma melhoria específica do Claude detectada nas fontes. */
export interface ClaudeImprovement {
  title: string
  category: "feature" | "api" | "sdk" | "model" | "pattern" | "tooling" | "mcp"
  whatItIs: string                 // O que é
  whatItDoes: string               // O que faz
  benefits: string[]               // Benefícios da implementação
  howToImplement: string           // Como implementar (geral)
  priority: "high" | "medium" | "low"
  sources: { platform: string; title: string; url: string }[]
  implementationByAgent: ImplementationByAgent
}

/** Uma API/serviço externo que pode ser conectado ao Claude. */
export interface ConnectableAPI {
  name: string
  whatItIs: string
  useCase: string                  // Pra que serve no contexto dos agentes
  howToConnect: string             // Como conectar (tool use / MCP / SDK / webhook)
  benefits: string[]
  docsUrl?: string
  appliesTo: string[]              // ["contentAgent","instagramDmAgent","camoSocialAgent"]
}

/** Resumo dos principais pontos de um tópico em uma plataforma. */
export interface TopicSummary {
  platform: "youtube" | "github" | "reddit" | "google" | "linkedin" | "web"
  topic: string
  summary: string
  takeaways: string[]
  url?: string
}

export interface AnalysisResult {
  youtubeInsights: YouTubeInsight[]
  githubProjects: GitHubProjectAnalysis[]
  claudeImprovements: ClaudeImprovement[]
  connectableAPIs: ConnectableAPI[]
  topicSummaries: TopicSummary[]
  implementationGuide: string
  priorityActions: string[]
  executiveSummary: string
  analysisDate: string
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [ClaudeAnalyzer] ${message}`)
}

function buildYouTubeSection(videos: VideoData[]): string {
  if (videos.length === 0) return "No new YouTube videos found in the last 24 hours.\n"

  return videos
    .map((v) => {
      const transcriptPreview = v.transcript
        ? `TRANSCRIPT (first 3000 chars):\n${v.transcript.slice(0, 3000)}`
        : "TRANSCRIPT: Not available."
      return `---
VIDEO: ${v.title}
URL: ${v.url}
PUBLISHED: ${v.publishedAt}
DURATION: ${v.duration}
DESCRIPTION: ${v.description.slice(0, 500)}
${transcriptPreview}
VISUAL OBSERVATIONS (from frame analysis):
${v.visualObservations}
---`
    })
    .join("\n\n")
}

function buildGitHubSection(repos: GitHubRepo[]): string {
  if (repos.length === 0) return "No new GitHub projects found matching the criteria.\n"

  return repos
    .map((r) => {
      const readmePreview = r.readme
        ? `README (first 2000 chars):\n${r.readme.slice(0, 2000)}`
        : "README: Not available."
      const pkgInfo = r.packageJson
        ? `PACKAGE.JSON (first 500 chars):\n${r.packageJson.slice(0, 500)}`
        : ""
      return `---
REPO: ${r.fullName}
URL: ${r.url}
STARS: ${r.stars} | FORKS: ${r.forks}
LANGUAGE: ${r.language ?? "Unknown"}
TOPICS: ${r.topics.join(", ")}
DESCRIPTION: ${r.description}
LAST UPDATED: ${r.updatedAt}
SECURITY SCORE: ${r.securityCheck.score}/100
${readmePreview}
${pkgInfo}
---`
    })
    .join("\n\n")
}

function buildSourcesSection(items: SourceItem[]): string {
  if (items.length === 0) return "No web/social sources gathered (Reddit/Google/LinkedIn).\n"

  // Agrupa por plataforma para o Claude entender a origem de cada bloco.
  const byPlatform = items.reduce<Record<string, SourceItem[]>>((acc, it) => {
    ;(acc[it.platform] ??= []).push(it)
    return acc
  }, {})

  return Object.entries(byPlatform)
    .map(([platform, list]) => {
      const blocks = list
        .map(
          (it) => `---
PLATFORM: ${platform.toUpperCase()}
TITLE: ${it.title}
URL: ${it.url}
FOUND VIA: ${it.query ?? "n/a"}${it.score !== undefined ? `\nSCORE/ENGAGEMENT: ${it.score}` : ""}${it.publishedAt ? `\nPUBLISHED: ${it.publishedAt}` : ""}
CONTENT:
${it.content}
---`
        )
        .join("\n\n")
      return `### ${platform.toUpperCase()} (${list.length} item(s))\n${blocks}`
    })
    .join("\n\n")
}

/**
 * AAR #2 — Batch API: envia a análise como um lote assíncrono (−50% de custo).
 * Faz polling até o batch terminar (ou estourar BATCH_MAX_WAIT_MS) e retorna o texto.
 */
async function runAnalysisViaBatch(
  client: Anthropic,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming
): Promise<string> {
  log("Submetendo análise via Message Batch (−50%, assíncrono)...")
  const batch = await client.messages.batches.create({
    requests: [{ custom_id: "daily-analysis", params }],
  })
  const maxMin = Math.round(BATCH_MAX_WAIT_MS / 60000)
  log(`Batch criado: ${batch.id}. Aguardando término (máx ${maxMin} min)...`)

  const deadline = Date.now() + BATCH_MAX_WAIT_MS
  let status = batch
  while (status.processing_status !== "ended") {
    if (Date.now() > deadline) {
      throw new Error(
        `Batch ${batch.id} não terminou em ${maxMin} min. ` +
          `Rode com USE_BATCH_API=false para resposta síncrona imediata.`
      )
    }
    await sleep(BATCH_POLL_INTERVAL_MS)
    status = await client.messages.batches.retrieve(batch.id)
    process.stdout.write(":")
  }
  console.log()

  const results = await client.messages.batches.results(batch.id)
  for await (const entry of results) {
    if (entry.custom_id !== "daily-analysis") continue
    if (entry.result.type === "succeeded") {
      return entry.result.message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
    }
    throw new Error(`Requisição do batch falhou com status: ${entry.result.type}`)
  }
  throw new Error("Batch terminou sem resultado para 'daily-analysis'.")
}

export async function analyzeWithClaude(
  apiKey: string,
  videos: VideoData[],
  repos: GitHubRepo[],
  sourceItems: SourceItem[] = [],
  memoryContext = ""
): Promise<AnalysisResult> {
  log("Starting Claude analysis...")
  log(`Input: ${videos.length} video(s), ${repos.length} GitHub repo(s), ${sourceItems.length} web source(s)`)

  const client = new Anthropic({ apiKey })

  const systemPrompt = `You are an expert AI developer intelligence analyst specializing in the Claude (Anthropic) ecosystem: Claude Code, the Claude/Anthropic API, the Agent SDK, MCP (Model Context Protocol), and connectable third-party APIs.

You analyze daily intelligence gathered from MULTIPLE sources — YouTube, GitHub, Reddit, Google search results and LinkedIn posts — and produce a single structured JSON report. Your TWO most important jobs are:
1. CLAUDE IMPROVEMENTS: identify the newest improvements that can be implemented IN CLAUDE specifically (new features, models, API params, SDK/Agent SDK capabilities, MCP servers, patterns) — what they are, what they do, the benefits, and how to implement them.
2. CONNECTABLE APIS: identify external APIs/services that can be CONNECTED to Claude (via tool use, MCP, SDK or webhooks) and how to wire them.

For EVERY improvement, you must explain how to implement it in EACH of the user's THREE production agents:
- contentAgent — "Agente de Conteúdo Diário" (this repo: Node/TS, Anthropic SDK, Supabase, Next.js dashboard).
- instagramDmAgent — "Agente de DM do Instagram" (instagram-dm-agent: Next.js, Anthropic SDK, Supabase, Instagram Graph webhooks).
- camoSocialAgent — "Agente de Social Media da Camo" (app Camo Intelligence em frontend-tturbo: gera/publica conteúdo social).

You produce precise, technical, developer-focused analysis in Portuguese (Brazilian) for the descriptive fields. You prioritize practical implementation value over marketing speak.
You ALWAYS respond with valid JSON matching the exact schema requested — no markdown fences, no extra text.`

  // AAR #1 — Conteúdo ESTÁTICO (persona + schema de saída). Idêntico em toda run,
  // então vai num bloco de system cacheado (cache hit paga ~10% do input).
  const outputFormatInstructions = `=== REQUIRED OUTPUT FORMAT ===
Respond with ONLY valid JSON matching this exact TypeScript interface (no markdown fences, no extra text):

{
  "youtubeInsights": [
    {
      "videoId": "string",
      "title": "string",
      "url": "string",
      "summary": "2-3 sentence technical summary of what was taught",
      "fullAnalysis": "COMPLETE and DETAILED analysis of the video in Portuguese (minimum 400 words). Cover: what was demonstrated, all technical concepts explained, who it is for, and what changed in the Claude ecosystem with this content.",
      "keyFeatures": ["List of ALL Claude Code features/APIs demonstrated — be exhaustive"],
      "visualDemonstrations": ["List of specific things shown on screen/in the demo"],
      "implementationTips": ["Concrete, copy-pasteable tips from this video — minimum 4 tips per video"],
      "implementationForOurSystem": "Detailed guide in Portuguese (minimum 300 words) explaining EXACTLY how to implement what was taught in this video in our daily content intelligence agent system. Mention specific files to modify, code patterns to adopt, and APIs to call.",
      "improvements": ["List of specific improvements and benefits this video's content brings to agent development — minimum 5 items"],
      "priorityLevel": "high | medium | low"
    }
  ],
  "githubProjects": [
    {
      "name": "string",
      "url": "string",
      "stars": 0,
      "description": "string",
      "whatItDoes": "Technical explanation of the project's functionality",
      "improvements": ["What improvements/innovations this offers over standard approaches — minimum 4 items"],
      "howToImplement": ["Step-by-step implementation steps for a developer — minimum 5 steps"],
      "implementationForOurSystem": "Detailed guide in Portuguese (minimum 250 words) explaining EXACTLY how to integrate this GitHub project into our 3 real agents. Cover: (1) Agente de Conteúdo (agente-de-conteudo-atualisado-claude) — which files to modify, what code to add; (2) Agente de DM do Instagram (instagram-dm-agent) — integration with Graph webhooks + Supabase; (3) Agente de Social Media da Camo (frontend-tturbo) — how it helps generate/schedule social content. Be specific about file names, code patterns, and measurable benefits.",
      "priority": "high | medium | low",
      "worthImplementing": true
    }
  ],
  "claudeImprovements": [
    {
      "title": "Short name of the Claude improvement",
      "category": "feature | api | sdk | model | pattern | tooling | mcp",
      "whatItIs": "O QUE É — explicação clara em português (2-4 frases).",
      "whatItDoes": "O QUE FAZ — o que essa melhoria permite/realiza, em português.",
      "benefits": ["BENEFÍCIOS concretos de implementar — mínimo 3 itens, em português"],
      "howToImplement": "COMO IMPLEMENTAR (geral) em português: passos, parâmetros de API, código quando útil.",
      "priority": "high | medium | low",
      "sources": [{ "platform": "youtube|github|reddit|google|linkedin|twitter|instagram", "title": "string", "url": "string" }],
      "implementationByAgent": {
        "contentAgent": "Como implementar no Agente de Conteúdo — arquivos e código específicos (português).",
        "instagramDmAgent": "Como implementar no Agente de DM do Instagram — fluxo de webhooks/Supabase (português).",
        "camoSocialAgent": "Como implementar no Agente de Social Media da Camo — geração/publicação de conteúdo (português)."
      }
    }
  ],
  "connectableAPIs": [
    {
      "name": "Nome da API/serviço externo",
      "whatItIs": "O que é, em português.",
      "useCase": "Pra que serve no contexto dos nossos agentes, em português.",
      "howToConnect": "Como conectar ao Claude: tool use / MCP / SDK / webhook — em português, com passos.",
      "benefits": ["Benefícios — mínimo 2 itens, em português"],
      "docsUrl": "https://... (se conhecido, senão string vazia)",
      "appliesTo": ["contentAgent", "instagramDmAgent", "camoSocialAgent"]
    }
  ],
  "topicSummaries": [
    {
      "platform": "youtube | github | reddit | google | linkedin | twitter | instagram | web",
      "topic": "Tópico/assunto principal abordado",
      "summary": "Resumo em português dos principais pontos abordados nesse tópico/conteúdo.",
      "takeaways": ["Principais aprendizados/itens — mínimo 2, em português"],
      "url": "https://... (link da fonte, se houver)"
    }
  ],
  "implementationGuide": "Comprehensive markdown guide in Portuguese (800-1200 words) on how to integrate today's discoveries across the 3 agents. Include code snippets where relevant.",
  "priorityActions": ["Top 5 specific, actionable tasks (in Portuguese) the developer should do TODAY based on this intelligence"],
  "executiveSummary": "3-4 sentence executive summary in Portuguese of today's most important Claude ecosystem developments (improvements + APIs)"
}

IMPORTANT:
- Produce claudeImprovements (3-8 items) and connectableAPIs (2-6 items) drawing from ALL sources (YouTube, GitHub, Reddit, Google, LinkedIn). These two arrays are the most important part of the report.
- Produce topicSummaries covering the main topics seen across every platform present in the data.
- If a source array is empty, simply produce fewer items — never invent fake URLs.`

  // AAR #1 — Conteúdo VARIÁVEL (memória + dados do dia) vai na mensagem do usuário.
  const userPrompt = `Analyze the following daily intelligence data and produce the structured JSON report exactly as defined in the system instructions (REQUIRED OUTPUT FORMAT).

=== AGENT MEMORY & PRIOR KNOWLEDGE ===
${memoryContext || "This is the first run — no prior knowledge exists yet."}

=== YOUTUBE INTELLIGENCE ===
${buildYouTubeSection(videos)}

=== GITHUB INTELLIGENCE ===
${buildGitHubSection(repos)}

=== WEB / SOCIAL INTELLIGENCE (Reddit, Google, LinkedIn) ===
${buildSourcesSection(sourceItems)}`

  // System cacheado: persona + schema estático (AAR #1). MODEL_DEEP = tiering (AAR #3).
  const messageParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: MODEL_DEEP,
    max_tokens: 16000,
    system: [
      {
        type: "text",
        text: `${systemPrompt}\n\n${outputFormatInstructions}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  }

  log(`Sending analysis to Claude (model=${MODEL_DEEP}, caching=on, batch=${USE_BATCH_API})...`)

  try {
    let fullText = ""

    if (USE_BATCH_API) {
      // AAR #2 — caminho assíncrono em lote (−50%).
      fullText = await runAnalysisViaBatch(client, messageParams)
    } else {
      // Caminho síncrono com streaming (relatório pronto na hora).
      const stream = await client.messages.create({ ...messageParams, stream: true })
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          fullText += event.delta.text
          process.stdout.write(".")
        }
      }
      console.log() // newline after dots
    }

    log(`Received ${fullText.length} chars from Claude.`)

    // Parse the JSON response
    // Claude sometimes wraps in markdown even when told not to — strip if present
    const cleaned = fullText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim()

    let parsed: Omit<AnalysisResult, "analysisDate">
    try {
      parsed = JSON.parse(cleaned) as Omit<AnalysisResult, "analysisDate">
    } catch (parseErr) {
      log(`JSON parse failed. Raw response preview: ${fullText.slice(0, 500)}`)
      throw new Error(`Claude returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
    }

    // Enrich each insight with the deep per-video analysis already generated by youtube-agent
    // (stored in visualObservations). Use it as fullAnalysis if Claude didn't fill it or it's thin.
    const videoObservations = new Map(videos.map((v) => [v.videoId, v.visualObservations]))
    const enrichedInsights = parsed.youtubeInsights.map((insight) => {
      const preAnalysis = videoObservations.get(insight.videoId) ?? ""
      return {
        ...insight,
        fullAnalysis: (insight.fullAnalysis && insight.fullAnalysis.length > 200)
          ? insight.fullAnalysis
          : preAnalysis || insight.fullAnalysis,
        implementationForOurSystem: insight.implementationForOurSystem ?? "",
        improvements: insight.improvements ?? [],
        priorityLevel: insight.priorityLevel ?? "medium",
      }
    })

    const result: AnalysisResult = {
      ...parsed,
      youtubeInsights: enrichedInsights,
      githubProjects: parsed.githubProjects ?? [],
      claudeImprovements: parsed.claudeImprovements ?? [],
      connectableAPIs: parsed.connectableAPIs ?? [],
      topicSummaries: parsed.topicSummaries ?? [],
      priorityActions: parsed.priorityActions ?? [],
      analysisDate: new Date().toISOString(),
    }

    log(
      `Analysis complete. ${result.youtubeInsights.length} videos, ${result.githubProjects.length} repos, ` +
        `${result.claudeImprovements.length} Claude improvements, ${result.connectableAPIs.length} APIs, ${result.topicSummaries.length} topic summaries.`
    )
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Claude analysis failed: ${msg}`)
    throw err
  }
}
