import * as https from "https"
import { YoutubeTranscript } from "youtube-transcript"
import Anthropic from "@anthropic-ai/sdk"
import { MODEL_LIGHT } from "../config/models"

export interface VideoData {
  videoId: string
  title: string
  url: string
  description: string
  transcript: string
  frames: never[]
  publishedAt: string
  duration: string
  visualObservations: string          // Full detailed analysis (full analysis tab)
  projectImplementation: string       // How to implement in the user's specific projects
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [YouTubeAgent] ${message}`)
}

// ---- RSS fetch (no API key required) ----

interface RssVideo {
  videoId: string
  title: string
  url: string
  publishedAt: string
  description: string
}

async function fetchChannelRSS(channelId: string): Promise<RssVideo[]> {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        let data = ""
        res.on("data", (chunk: Buffer) => (data += chunk.toString()))
        res.on("end", () => {
          try {
            const entries = data.split("<entry>").slice(1)
            const videos: RssVideo[] = entries.map((entry) => {
              const videoId = (entry.match(/watch\?v=([a-zA-Z0-9_-]{11})/) ?? [])[1] ?? ""
              const title = (entry.match(/<title>(.+?)<\/title>/) ?? [])[1] ?? ""
              const publishedAt = (entry.match(/<published>(.+?)<\/published>/) ?? [])[1] ?? ""
              const description = (entry.match(/<media:description>([\s\S]*?)<\/media:description>/) ?? [])[1] ?? ""
              return {
                videoId,
                title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
                url: `https://www.youtube.com/watch?v=${videoId}`,
                publishedAt,
                description: description.trim().slice(0, 800),
              }
            })
            resolve(videos.filter((v) => v.videoId.length === 11))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on("error", reject)
  })
}

// ---- Transcript ----

async function getTranscript(videoId: string): Promise<string> {
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId)
    return items.map((i) => i.text).join(" ")
  } catch {
    return ""
  }
}

// Context about the user's real projects — used to generate project-specific implementation guides
const USER_PROJECTS_CONTEXT = `
## Projetos reais do desenvolvedor:

### 1. Agente de Conteúdo Diário (agente-de-conteudo-atualisado-claude)
- **O que faz**: Monitora diariamente o canal @claude no YouTube via RSS e projetos no GitHub via Octokit
- **Stack**: Node.js + TypeScript, Anthropic SDK, Supabase (Storage + DB), Next.js dashboard, Vercel
- **Arquivos principais**: src/index.ts (orquestrador 7 steps), src/agents/youtube-agent.ts, src/agents/github-agent.ts, src/services/claude-analyzer.ts, src/services/agent-memory.ts
- **Memória**: Anthropic Memory Stores (memstore_01Hss...) com 4 arquivos: /analyzed-videos.md, /analyzed-repos.md, /learned-knowledge.md, /agent-stats.md
- **Auto-aprendizado**: Dreaming toda semana — consolida o memory store com Claude Opus
- **Dashboard**: https://dashboard-tturbo.vercel.app — mostra vídeos, GitHub repos, análises, resumo executivo

### 2. Agente de Instagram DM (instagram-dm-agent)
- **O que faz**: Responde DMs do Instagram automaticamente usando Claude
- **Stack**: Next.js App Router, Anthropic SDK, Supabase, webhooks do Instagram Graph API
- **Tem memória**: Memory Store separado para contexto de conversas

### 3. Plataforma de Medicina (em planejamento)
- **Objetivo**: Tutor de IA para estudantes de medicina — um agente por aluno
- **Complexidade**: Muitos usuários simultâneos, múltiplos agentes, várias especialidades médicas
- **Stack planejada**: Claude Managed Agents, skills por especialidade, sub-agente de avaliação
`

// ---- Claude analysis of transcript + description ----

interface VideoAnalysis {
  fullAnalysis: string
  projectImplementation: string
}

async function analyzeVideoWithClaude(
  client: Anthropic,
  video: { title: string; description: string; transcript: string }
): Promise<VideoAnalysis> {
  const hasTranscript = video.transcript.length > 200
  const content = hasTranscript
    ? `## Transcrição completa:\n${video.transcript.slice(0, 12000)}`
    : `## Descrição:\n${video.description}`

  const [analysisRes, implRes] = await Promise.all([
    // Call 1: Full technical analysis (AAR #3 — tarefa de análise/resumo usa MODEL_LIGHT)
    client.messages.create({
      model: MODEL_LIGHT,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Você é um analista técnico especializado em Claude Code e desenvolvimento de agentes de IA.

Analise este vídeo do canal oficial da Anthropic (@claude):

## Título: ${video.title}

${content}

Forneça uma análise detalhada com:

1. **Resumo Executivo** (3-5 frases): O que foi ensinado/demonstrado?

2. **Principais Conceitos** (liste 5-7 itens técnicos específicos com nomes de APIs, ferramentas, padrões)

3. **Demonstração Prática**: O que foi mostrado na tela/código? Descreva cada passo

4. **Por que isso importa**: Impacto no ecossistema de agentes Claude — casos de uso reais

5. **Nível de Prioridade para Implementação** (Alto/Médio/Baixo com justificativa)

Responda em português. Seja técnico e específico — o leitor é um desenvolvedor experiente.`,
        },
      ],
    }),

    // Call 2: Project-specific implementation guide
    // (AAR #3 — MODEL_LIGHT; AAR #1 — contexto estático dos projetos cacheado no system)
    client.messages.create({
      model: MODEL_LIGHT,
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: `Você é um arquiteto de software especializado em agentes de IA com Claude.

Contexto dos projetos reais do desenvolvedor (use como base para os guias de implementação):
---
${USER_PROJECTS_CONTEXT}
---`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Um desenvolvedor assistiu ao seguinte vídeo da Anthropic:

## Título: ${video.title}

${content}

Com base no conteúdo do vídeo e nos projetos reais do contexto do sistema, escreva um **guia de implementação específico** respondendo:

1. **Como isso melhora o Agente de Conteúdo Diário?**
   - Que arquivos seriam modificados? (ex: src/services/agent-memory.ts, src/index.ts)
   - Que código concreto seria adicionado ou alterado?
   - Qual benefício mensurável isso traria?

2. **Como isso melhora o Agente de Instagram DM?**
   - Aplicação específica para o contexto de atendimento por DM
   - Como integraria com o fluxo atual de webhooks + Supabase?

3. **Como isso estrutura a Plataforma de Medicina?**
   - Como aplicar para múltiplos agentes (um por aluno)?
   - Qual primitiva usar: tool, skill ou sub-agente? Por quê?
   - Como escalar para milhares de usuários simultâneos?

4. **Passos concretos para implementar agora** (lista numerada, do mais simples ao mais complexo)

Responda em português. Seja muito específico — mencione arquivos reais, padrões de código concretos e benefícios quantificáveis.`,
        },
      ],
    }),
  ])

  const analysisBlock = analysisRes.content.find((b) => b.type === "text")
  const implBlock = implRes.content.find((b) => b.type === "text")

  return {
    fullAnalysis: analysisBlock && "text" in analysisBlock ? analysisBlock.text : "Análise não disponível.",
    projectImplementation: implBlock && "text" in implBlock ? implBlock.text : "Guia de implementação não disponível.",
  }
}

// ---- Main export ----

export async function fetchRecentVideos(
  _youtubeApiKey: string,
  channelId: string,
  anthropicApiKey: string,
  hoursBack: number = 48
): Promise<VideoData[]> {
  log(`Buscando vídeos do canal ${channelId} via RSS (últimas ${hoursBack}h)...`)

  const client = new Anthropic({ apiKey: anthropicApiKey })
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000)

  const rssVideos = await fetchChannelRSS(channelId)
  log(`RSS retornou ${rssVideos.length} vídeos no total.`)

  const recent = rssVideos.filter((v) => {
    if (!v.publishedAt) return false
    return new Date(v.publishedAt) > cutoff
  })

  log(`${recent.length} vídeos dentro da janela de ${hoursBack}h.`)

  if (recent.length === 0) {
    log("Nenhum vídeo novo na janela. Retornando lista vazia.")
    return []
  }

  const results: VideoData[] = []

  for (const v of recent) {
    log(`Processando: "${v.title}" (${v.videoId})`)

    const transcript = await getTranscript(v.videoId)
    if (transcript) {
      log(`  Transcrição OK: ${transcript.length} chars`)
    } else {
      log(`  Transcrição indisponível, usando descrição`)
    }

    const analysis = await analyzeVideoWithClaude(client, {
      title: v.title,
      description: v.description,
      transcript,
    })

    results.push({
      videoId: v.videoId,
      title: v.title,
      url: v.url,
      description: v.description,
      transcript,
      frames: [],
      publishedAt: v.publishedAt,
      duration: "N/A",
      visualObservations: analysis.fullAnalysis,
      projectImplementation: analysis.projectImplementation,
    })
  }

  log(`${results.length} vídeo(s) processados com sucesso.`)
  return results
}
