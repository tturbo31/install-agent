/**
 * Script: fix-implementation-guides.ts
 *
 * Busca o relatório mais recente do Supabase, identifica os vídeos 5-9
 * que têm "implementationForOurSystem" vazio, busca a transcrição do YouTube,
 * gera o guia com Claude e atualiza o banco de dados.
 *
 * Executar: npx tsx fix-implementation-guides.ts
 */

import { createClient } from "@supabase/supabase-js"
import Anthropic from "@anthropic-ai/sdk"
import { YoutubeTranscript } from "youtube-transcript"
import * as dotenv from "dotenv"

dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

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

async function getTranscript(videoId: string): Promise<string> {
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId)
    return items.map((i) => i.text).join(" ")
  } catch {
    return ""
  }
}

async function generateImplementationGuide(
  client: Anthropic,
  video: { title: string; summary: string; fullAnalysis: string; transcript: string }
): Promise<string> {
  const content = video.transcript.length > 200
    ? `## Transcrição completa:\n${video.transcript.slice(0, 12000)}`
    : video.fullAnalysis.length > 100
      ? `## Análise completa disponível:\n${video.fullAnalysis.slice(0, 8000)}`
      : `## Resumo:\n${video.summary}`

  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `Você é um arquiteto de software especializado em agentes de IA com Claude.

Um desenvolvedor assistiu ao seguinte vídeo da Anthropic:

## Título: ${video.title}

${content}

---
${USER_PROJECTS_CONTEXT}
---

Com base no conteúdo do vídeo e nos projetos reais acima, escreva um **guia de implementação específico** respondendo:

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
  })

  const block = res.content.find((b) => b.type === "text")
  return block && "text" in block ? block.text : "Guia não disponível."
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  // Fetch the latest report
  log("Buscando relatório mais recente no Supabase...")
  const { data: report, error } = await supabase
    .from("daily_reports")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (error || !report) {
    log(`Erro ao buscar relatório: ${error?.message}`)
    process.exit(1)
  }

  log(`Relatório encontrado: ID=${report.id}, data=${report.analysis_date}, run=${report.run_number}`)

  const insights: any[] = report.youtube_insights ?? []
  log(`Total de vídeos no relatório: ${insights.length}`)

  // Videos 5-9 = indices 4-8
  const targetIndices = [4, 5, 6, 7, 8].filter((i) => i < insights.length)
  log(`Vídeos alvo (índices ${targetIndices.join(", ")}): ${targetIndices.length} vídeo(s)`)

  let anyUpdated = false

  for (const idx of targetIndices) {
    const video = insights[idx]
    const videoNum = idx + 1

    log(`\n--- Vídeo #${videoNum}: "${video.title}" (${video.videoId}) ---`)

    const existing = (video.implementationForOurSystem ?? "").trim()
    const isEmpty = !existing || existing === "Guia de implementação não disponível para este video." || existing.length < 50

    if (!isEmpty) {
      log(`  Já tem guia (${existing.length} chars). Pulando.`)
      continue
    }

    log(`  Sem guia. Buscando transcrição...`)
    const transcript = await getTranscript(video.videoId)
    log(`  Transcrição: ${transcript.length > 0 ? transcript.length + " chars" : "não disponível"}`)

    log(`  Gerando guia com Claude...`)
    const guide = await generateImplementationGuide(anthropic, {
      title: video.title,
      summary: video.summary ?? "",
      fullAnalysis: video.fullAnalysis ?? "",
      transcript,
    })

    log(`  Guia gerado: ${guide.length} chars`)
    insights[idx] = { ...video, implementationForOurSystem: guide }
    anyUpdated = true
  }

  if (!anyUpdated) {
    log("\nNenhum vídeo precisava de atualização.")
    return
  }

  // Update the report in Supabase
  log("\nAtualizando relatório no Supabase...")
  const { error: updateError } = await supabase
    .from("daily_reports")
    .update({ youtube_insights: insights })
    .eq("id", report.id)

  if (updateError) {
    log(`Erro ao atualizar: ${updateError.message}`)
    process.exit(1)
  }

  log("Relatório atualizado com sucesso!")
  log(`Vídeos atualizados: ${targetIndices.length}`)
}

main().catch((err) => {
  console.error("Erro fatal:", err)
  process.exit(1)
})
