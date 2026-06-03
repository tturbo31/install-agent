# AAR — After Action Report: Melhorias de IA & Agentes disponíveis no mundo

> **Data:** 2026-06-02 · **Autor:** Agente Camo Intelligence
> **Objetivo:** registrar as melhorias mais recentes (Google, Reddit, fóruns, docs oficiais) que podem ser aplicadas aos projetos da Camo. Cada item segue o formato:
> **O que é → O que faz → Por que melhora → Como implementar em cada projeto.**
>
> Projetos cobertos: **(A)** Agente de Conteúdo (este repo / dashboard Camo) · **(B)** Dashboard Camo (frontend Next.js) · **(C)** instagram-dm-agent · **(D)** pixel-agents.

---

## Sumário executivo

| # | Melhoria | Impacto | Esforço | Status |
|---|----------|---------|---------|--------|
| 1 | Prompt Caching em todo contexto reutilizado | Custo −90% no input cacheado | Baixo | ✅ **Implementado** (2026-06-02) |
| 2 | Batch API para o job noturno | Custo −50% adicional | Médio | ✅ **Implementado** (opt-in `USE_BATCH_API`) |
| 3 | Model tiering (Opus/Sonnet/Haiku por tarefa) | Custo/velocidade | Baixo | ✅ **Implementado** (`MODEL_DEEP`/`MODEL_LIGHT`) |
| 4 | Subagents + Agent Teams (paralelizar + isolar contexto) | Velocidade/qualidade | Médio | A fazer |
| 5 | Skills (.claude/skills) versionadas no repo | Padronização | Baixo | A fazer |
| 6 | Hooks (gates determinísticos) | Confiabilidade | Baixo | A fazer |
| 7 | Extração estruturada (JSON Schema) no scraping | Dados confiáveis | Médio | A fazer |
| 8 | Firecrawl/Crawl4AI para fontes além de API (Reddit/fóruns/blogs) | Cobertura de fontes | Médio | A fazer |
| 9 | Memória: Intelligent Decay + escopo/conflito | Memória útil a longo prazo | Médio | Base pronta |
| 10 | Dynamic Workflows / ultracode | Orquestração autônoma | Médio | A avaliar |

---

## 1. Prompt Caching em todo contexto reutilizado

- **O que é:** marcar blocos de conteúdo repetidos (system prompt grande, contexto de memória, instruções fixas) com `cache_control: { type: "ephemeral" }` para a Anthropic reaproveitar o cache em vez de reprocessar tokens.
- **O que faz:** cache *hit* paga só **0,10×** do preço de input; a escrita custa 1,25× (TTL 5 min) ou 2,0× (TTL 1 h).
- **Por que melhora:** **85–90% de redução** no custo do input reutilizado. Em um agente que roda todo dia com o mesmo prompt-base + memória crescente, isso é dinheiro recorrente economizado.
- **Como implementar:**
  - **(A) Agente de Conteúdo:** já usa em [src/services/claude-analyzer.ts](../src/services/claude-analyzer.ts) (`cache_control` na linha ~180). **Expandir** para também cachear: (1) o `memoryContext` (que cresce a cada run) e (2) o system prompt do [src/agents/youtube-agent.ts](../src/agents/youtube-agent.ts). Coloque os blocos estáveis primeiro e o conteúdo variável por último.
  - **(B) Dashboard:** N/A (não chama LLM em runtime). Se adicionar busca/IA no dashboard, aplicar o mesmo padrão.
  - **(C) instagram-dm-agent / (D) pixel-agents:** marcar o prompt de persona/instruções fixas com `cache_control`. Ganho proporcional ao tamanho do prompt fixo.

## 2. Batch API para o job noturno

- **O que é:** a Message Batches API processa requests de forma assíncrona (retorno em até 24 h) a **50% do preço**.
- **O que faz:** ideal para "nightly analytics jobs" — exatamente o caso do agente diário, que não precisa de resposta em tempo real.
- **Por que melhora:** **−50%** somados ao prompt caching ⇒ até **~95%** de economia combinada. Suporta saídas longas (até 300K tokens com header beta `output-300k-2026-03-24`).
- **Como implementar:**
  - **(A):** no Step 3 (análise Claude), trocar `messages.create` síncrono por submissão em batch quando a janela de latência permitir (o cron roda 08:00 BRT; resultado pode chegar mais tarde e o dashboard atualiza quando salvar). Manter o caminho síncrono como fallback se precisar do relatório na hora.
  - **(C)/(D):** usar batch para enriquecimento/classificação em massa (ex.: lotes de DMs, lotes de imagens), não para interação ao vivo.

## 3. Model tiering (Opus / Sonnet / Haiku por tarefa)

- **O que é:** escolher o modelo pela dificuldade da tarefa em vez de usar Opus para tudo.
- **O que faz:** Opus para raciocínio complexo, Sonnet para o grosso do trabalho, Haiku para tarefas simples (classificar, resumir curto, deduplicar).
- **Por que melhora:** corta custo e latência sem perder qualidade onde não importa.
- **Como implementar:**
  - **(A):** hoje há inconsistência — [claude-analyzer.ts](../src/services/claude-analyzer.ts) usa `claude-opus-4-5` e [youtube-agent.ts](../src/agents/youtube-agent.ts) usa `claude-opus-4-7`. **Padronizar** num único ponto: criar `MODEL_DEEP` (Opus, p/ análise/visão) e `MODEL_LIGHT` (Sonnet/Haiku, p/ dedupe/resumo curto) lidos de env. Sugestão de default atual: `claude-opus-4-8` (deep) e `claude-sonnet-4-6` (light).
  - **(C)/(D):** Haiku 4.5 para triagem barata; Sonnet para redação; Opus só quando precisar de raciocínio.

## 4. Subagents + Agent Teams

- **O que é:** delegar partes do trabalho a subagentes que rodam em **contexto isolado** e em **paralelo**.
- **O que faz:** evita que uma tarefa pesada (ex.: ler 50 repos) consuma a janela de contexto principal; o `description` do subagente funciona como regra de roteamento.
- **Por que melhora:** mais velocidade (paralelismo) e mais qualidade (contexto limpo). É o caminho padrão de 2026 para tarefas de dev.
- **Como implementar:**
  - **(A):** definir subagentes versionados em `.claude/agents/`: um "pesquisador" (varre fontes), um "analista" (estrutura achados), um "implementador". O orquestrador `index.ts` continua serial, mas o trabalho de *dev* do projeto passa a usar subagentes.
  - **(B)/(C)/(D):** commitar agentes especialistas compartilhados (reviewer, test-runner, doc-writer) para todo mundo usar a mesma definição.

## 5. Skills versionadas no repositório (.claude/skills)

- **O que é:** empacotar fluxos recorrentes como Skills (contexto *on-demand*) em vez de jogar tudo no CLAUDE.md (contexto *always-on*).
- **O que faz:** Claude carrega a skill só quando o pedido casa com a `description`.
- **Por que melhora:** mantém o contexto enxuto e padroniza tarefas (ex.: "gerar relatório AAR", "revisar PR", "publicar no dashboard").
- **Como implementar:**
  - **(A):** criar skill `gerar-aar` que reproduz exatamente este documento (pesquisar → estruturar → escrever em `reports/`). Assim o próprio agente gera AARs novos todo dia.
  - **Regra geral:** se a regra vale para quase toda tarefa → CLAUDE.md; se é um fluxo específico → Skill.

## 6. Hooks (gates determinísticos)

- **O que é:** scripts que rodam em torno de eventos (antes de parar, após editar, no commit).
- **O que faz:** impõem regras sem depender do julgamento do modelo: rodar testes antes de finalizar, bloquear edição de arquivos gerados, rodar lint/scan de segurança.
- **Por que melhora:** confiabilidade — o que é obrigatório vira determinístico.
- **Como implementar:**
  - **(A):** hook que roda `npm run typecheck` (agente) e `npm run build` (dashboard) antes de concluir uma tarefa, evitando regressões como a que quebrou o build (arquivos faltando).
  - **(C)/(D):** hook de scan de segurança após mudança de dependências.

## 7. Extração estruturada com JSON Schema no scraping

- **O que é:** forçar o LLM a devolver JSON validado por schema em vez de texto livre.
- **O que faz:** você descreve os campos desejados e valida/normaliza no pós-processamento.
- **Por que melhora:** dados confiáveis e estáveis para o dashboard (sem campos faltando/“alucinados”).
- **Como implementar:**
  - **(A):** o `AnalysisResult` já é tipado; reforçar a saída do Claude com schema explícito (tool/JSON mode) e validação (ex.: `zod`) antes de salvar no Supabase. Garante que `whatItDoes`, `improvements`, `howToImplement`, `implementationForOurSystem` nunca venham vazios silenciosamente.

## 8. Firecrawl / Crawl4AI para fontes além de API (Reddit, fóruns, blogs)

- **O que é:** APIs que transformam qualquer URL em Markdown/JSON limpos prontos para LLM, com render de JS, CAPTCHA e rotação de proxy nativos. Suportam MCP (o agente chama como ferramenta).
- **O que faz:** permite ir além de YouTube API + GitHub API e capturar **Reddit, Hacker News, fóruns e blogs** — exatamente as fontes que você pediu.
- **Por que melhora:** cobertura de fontes muito maior = mais melhorias detectadas por dia. Anti-bot (Cloudflare Turnstile, DataDome) já não é opcional em produção.
- **Como implementar:**
  - **(A):** adicionar `src/agents/web-agent.ts` que usa Firecrawl (ou Crawl4AI self-hosted) para buscar posts recentes de subreddits (`r/ClaudeAI`, `r/LocalLLaMA`), HN e blogs, devolvendo Markdown → alimenta o mesmo Step 3 de análise. Guardar `FIRECRAWL_API_KEY` em secret.
  - **(C):** útil para monitorar tendências de conteúdo do nicho.

## 9. Memória de longo prazo: Intelligent Decay + escopo/conflito/confiança

- **O que é:** a Anthropic tornou memória persistente um componente de 1ª classe (Memory for Managed Agents, abr/2026) e lançou "Dreaming" (mai/2026) para reorganizar memória entre sessões.
- **O que faz:** além de guardar, **poda/consolida** memórias por um score composto (recência + relevância + utilidade) e trata escopo, frescor e conflito.
- **Por que melhora:** a memória continua útil ao longo de centenas de runs em vez de virar lixo acumulado.
- **Como implementar:**
  - **(A):** o repo **já tem** memory store + `runDreaming` em [src/services/agent-memory.ts](../src/services/agent-memory.ts) — alinhado com o estado da arte. Evoluir o `shouldRunDreaming` para um score de decaimento (recência/relevância/utilidade) e registrar *por que* cada padrão foi mantido/descartado (auditoria).

## 10. Dynamic Workflows / ultracode

- **O que é:** Claude Code cria scripts de orquestração, quebra em subtarefas, roda em paralelo e valida antes de responder; progresso é salvo (retomável).
- **O que faz:** formaliza workflows que hoje você monta na mão.
- **Por que melhora:** orquestração autônoma de tarefas grandes (ex.: refatorar os 4 projetos ao mesmo tempo).
- **Como implementar:** avaliar `ultracode` para tarefas multi-projeto; para o pipeline diário, o `index.ts` serial já cobre o caso — usar Dynamic Workflows nas tarefas de *desenvolvimento*, não no cron.

---

## Como esta plataforma deve consumir este AAR (visão de produto)

O dashboard Camo já tem a estrutura certa para exibir isto: cada card de vídeo/repo tem as abas **Visão Geral**, **Análise Completa** e **Como Implementar**, e os campos `whatItDoes`, `improvements`, `howToImplement` e `implementationForOurSystem`. Recomendações:

1. **Seção "Melhorias do dia"** alimentada por este formato (o que faz / por que / como implementar por projeto). O agente diário já produz `priority_actions` e `implementation_guide` — basta padronizar a saída no formato deste AAR.
2. **Por projeto:** adicionar no schema um campo `appliesTo: ["A","C","D"]` para filtrar melhorias por projeto no dashboard.
3. **Histórico:** a sidebar de relatórios já versiona por dia — cada AAR vira um item navegável.

---

## Fontes

**Skills / Subagents / Workflows**
- [Create custom subagents — Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [A Mental Model for Claude Code: Skills, Subagents, and Plugins — Level Up Coding](https://levelup.gitconnected.com/a-mental-model-for-claude-code-skills-subagents-and-plugins-3dea9924bf05)
- [Claude Code: Hooks, Subagents, and Skills — Complete Guide (2026)](https://ofox.ai/blog/claude-code-hooks-subagents-skills-complete-guide-2026/)
- [Claude Code Agent Teams, Subagents, and MCP: The 2026 Playbook — Developers Digest](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026)
- [Advanced Best Practices: Hooks, Subagents & Context Management (2026) — SmartScope](https://smartscope.blog/en/generative-ai/claude/claude-code-best-practices-advanced-2026/)
- [Best Claude Code Skills to Try in 2026 — Firecrawl](https://www.firecrawl.dev/blog/best-claude-code-skills)
- [Claude Code Adds Dynamic Workflows for Parallel Agent Coordination — InfoQ](https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code/)
- [Common workflows — Claude Code Docs](https://code.claude.com/docs/en/common-workflows)
- [Claude Code Agents in 2026 (custos/paralelismo) — CloudZero](https://www.cloudzero.com/blog/claude-code-agents/)

**Memória de agentes**
- [Anthropic adds persistent memory to Claude Managed Agents — EdTech Innovation Hub](https://www.edtechinnovationhub.com/news/anthropic-brings-persistent-memory-to-claude-managed-agents-in-public-beta)
- [Anthropic's Managed Agents memory: what it changes — Wire Blog](https://usewire.io/blog/anthropic-managed-agents-memory-context-engineering/)
- [State of AI Agent Memory 2026 — mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [AI Agent Memory 2026: Vector, Graph, Episodic — Digital Applied](https://www.digitalapplied.com/blog/ai-agent-memory-vector-graph-episodic-2026)
- [Context Architecture for AI Agents: A Complete 2026 Guide — Atlan](https://atlan.com/know/context-architecture-for-ai-agents/)

**Scraping / extração estruturada**
- [The Ultimate Guide to Web Scraping (2026) — Browser Use](https://browser-use.com/posts/web-scraping-guide-2026)
- [Best AI Web Scraping Tools of 2026 — Bright Data](https://brightdata.com/blog/ai/best-ai-scraping-tools)
- [What is an Anti-Scraping Mechanism — Firecrawl](https://www.firecrawl.dev/glossary/web-scraping-apis/what-is-anti-scraping-mechanism)
- [The Future of Web Scraping in 2026 — Apify](https://use-apify.com/blog/future-of-web-scraping-2026)

**Custo / Prompt Caching / Batch**
- [Prompt caching — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Anthropic API Pricing in 2026: Caching, Batch & Optimization — Finout](https://www.finout.io/blog/anthropic-api-pricing)
- [Cut Anthropic API Costs 90% with Prompt Caching 2026 — Markaicode](https://markaicode.com/anthropic-prompt-caching-reduce-api-costs/)
