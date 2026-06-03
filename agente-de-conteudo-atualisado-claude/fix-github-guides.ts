/**
 * Script: fix-github-guides.ts
 * Gera implementationForOurSystem para todos os repos GitHub do último relatório
 * que ainda não têm esse campo preenchido.
 *
 * Executar: npx tsx fix-github-guides.ts
 */

import { createClient } from "@supabase/supabase-js"
import Anthropic from "@anthropic-ai/sdk"
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
- **Stack**: Node.js + TypeScript, Anthropic SDK, Supabase (Storage + DB), Next.js dashboard, Vercel
- **Arquivos principais**: src/index.ts, src/agents/youtube-agent.ts, src/agents/github-agent.ts, src/services/claude-analyzer.ts, src/services/agent-memory.ts
- **Memória**: Anthropic Memory Stores com 4 arquivos: /analyzed-videos.md, /analyzed-repos.md, /learned-knowledge.md, /agent-stats.md
- **Auto-aprendizado**: Dreaming toda semana — consolida o memory store com Claude Opus

### 2. Agente de Instagram DM (instagram-dm-agent)
- **Stack**: Next.js App Router, Anthropic SDK, Supabase, webhooks do Instagram Graph API
- **Tem memória**: Memory Store separado para contexto de conversas

### 3. Plataforma de Medicina (em planejamento)
- **Objetivo**: Tutor de IA para estudantes de medicina — um agente por aluno
- **Stack planejada**: Claude Managed Agents, skills por especialidade, sub-agente de avaliação
`

async function generateGuide(
  client: Anthropic,
  repo: { name: string; description: string; whatItDoes: string; howToImplement: string[]; improvements: string[] }
): Promise<string> {
  const steps = repo.howToImplement.map((s, i) => `${i + 1}. ${s}`).join("\n")
  const improvements = repo.improvements.map((s) => `- ${s}`).join("\n")

  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `Você é um arquiteto de software especializado em agentes de IA com Claude.

Um desenvolvedor encontrou o seguinte repositório no GitHub:

## Repositório: ${repo.name}
**Descrição**: ${repo.description}

**O que faz**: ${repo.whatItDoes}

**Melhorias que oferece**:
${improvements}

**Passos de implementação genéricos**:
${steps}

---
${USER_PROJECTS_CONTEXT}
---

Com base neste repositório e nos projetos reais acima, escreva um **guia de implementação específico** em português respondendo:

1. **Como isso melhora o Agente de Conteúdo Diário?**
   - Que arquivos seriam modificados? (ex: src/services/agent-memory.ts, src/index.ts)
   - Que código concreto seria adicionado ou alterado?
   - Qual benefício mensurável isso traria?

2. **Como isso melhora o Agente de Instagram DM?**
   - Aplicação específica para o contexto de atendimento por DM
   - Como integraria com o fluxo atual de webhooks + Supabase?

3. **Como isso estrutura a Plataforma de Medicina?**
   - Como aplicar para múltiplos agentes (um por aluno)?
   - Como escalar para milhares de usuários simultâneos?

4. **Passos concretos para implementar agora** (lista numerada, do mais simples ao mais complexo)

Seja muito específico — mencione arquivos reais, padrões de código concretos e benefícios quantificáveis.`,
    }],
  })

  const block = res.content.find((b) => b.type === "text")
  return block && "text" in block ? block.text : "Guia não disponível."
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  log("Buscando relatório mais recente...")
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

  log(`Relatório: run=${report.run_number}, ID=${report.id.slice(0, 8)}`)

  const projects: any[] = report.github_projects ?? []
  log(`Total de repos: ${projects.length}`)

  let updated = false

  for (let i = 0; i < projects.length; i++) {
    const proj = projects[i]
    const existing = (proj.implementationForOurSystem ?? "").trim()
    const isEmpty = !existing || existing.length < 50

    log(`\nRepo #${i + 1}: ${proj.name}`)

    if (!isEmpty) {
      log(`  Já tem guia (${existing.length} chars). Pulando.`)
      continue
    }

    log(`  Gerando guia com Claude...`)
    const guide = await generateGuide(anthropic, {
      name: proj.name,
      description: proj.description ?? "",
      whatItDoes: proj.whatItDoes ?? "",
      howToImplement: proj.howToImplement ?? [],
      improvements: proj.improvements ?? [],
    })
    log(`  Guia gerado: ${guide.length} chars`)
    projects[i] = { ...proj, implementationForOurSystem: guide }
    updated = true
  }

  if (!updated) {
    log("\nTodos os repos já têm guia. Nenhuma atualização necessária.")
    return
  }

  log("\nAtualizando no Supabase...")
  const { error: updateError } = await supabase
    .from("daily_reports")
    .update({ github_projects: projects })
    .eq("id", report.id)

  if (updateError) {
    log(`Erro: ${updateError.message}`)
    process.exit(1)
  }

  log("Atualizado com sucesso!")
}

main().catch((err) => {
  console.error("Erro fatal:", err)
  process.exit(1)
})
