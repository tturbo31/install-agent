/**
 * Curadoria dos melhores especialistas/contas por plataforma para acompanhar
 * melhorias do Claude, APIs e agentes de IA. Usado para montar a aba de cada plataforma.
 * (Contas reais e verificáveis; handles incertos usam links de busca.)
 */

export interface Expert {
  name: string;
  handle: string;
  url: string;
  note: string;
}

export interface PlatformDef {
  id: string;
  label: string;
  emoji: string;
  blurb: string;
  /** Plataformas (do campo topic_summaries.platform / sources.platform) que alimentam esta aba. */
  dataKeys: string[];
  experts: Expert[];
}

export const PLATFORMS: PlatformDef[] = [
  {
    id: "youtube",
    label: "YouTube",
    emoji: "▶",
    blurb: "Canais que demonstram features do Claude, Claude Code e agentes.",
    dataKeys: ["youtube"],
    experts: [
      { name: "Anthropic", handle: "@anthropic-ai", url: "https://www.youtube.com/@anthropic-ai", note: "Canal oficial — lançamentos, Claude Code, pesquisa." },
      { name: "Matthew Berman", handle: "@matthew_berman", url: "https://www.youtube.com/@matthew_berman", note: "Notícias de IA, modelos e agentes, hands-on." },
      { name: "AI Jason", handle: "@AIJasonZ", url: "https://www.youtube.com/@AIJasonZ", note: "Construção de apps e agentes com LLMs." },
      { name: "Cole Medin", handle: "@ColeMedin", url: "https://www.youtube.com/@ColeMedin", note: "Agentes de IA, RAG e fluxos práticos." },
    ],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    emoji: "in",
    blurb: "Líderes que discutem estratégia, adoção e agentic AI no mundo corporativo.",
    dataKeys: ["linkedin"],
    experts: [
      { name: "Andrew Ng", handle: "in/andrewyng", url: "https://www.linkedin.com/in/andrewyng", note: "DeepLearning.AI — workflows agênticos e educação." },
      { name: "Allie K. Miller", handle: "in/alliekmiller", url: "https://www.linkedin.com/in/alliekmiller", note: "Estratégia e ROI de IA para negócios." },
      { name: "Ethan Mollick", handle: "in/emollick", url: "https://www.linkedin.com/in/emollick", note: "IA aplicada ao trabalho do dia a dia." },
      { name: "Bernard Marr", handle: "in/bernardmarr", url: "https://www.linkedin.com/in/bernardmarr", note: "Tendências macro de IA por setor." },
    ],
  },
  {
    id: "twitter",
    label: "Twitter / X",
    emoji: "𝕏",
    blurb: "Onde as features do Claude saem primeiro — engenheiros e DevRel da Anthropic.",
    dataKeys: ["twitter"],
    experts: [
      { name: "Anthropic", handle: "@AnthropicAI", url: "https://x.com/AnthropicAI", note: "Conta oficial — releases e pesquisa." },
      { name: "Claude", handle: "@claudeai", url: "https://x.com/claudeai", note: "Conta do produto Claude." },
      { name: "Boris Cherny", handle: "@bcherny", url: "https://x.com/bcherny", note: "Criador do Claude Code — setups e features." },
      { name: "Alex Albert", handle: "@alexalbert__", url: "https://x.com/alexalbert__", note: "DevRel da Anthropic — dicas e novidades." },
      { name: "Andrej Karpathy", handle: "@karpathy", url: "https://x.com/karpathy", note: "Pesquisa em LLMs (Anthropic)." },
    ],
  },
  {
    id: "instagram",
    label: "Instagram",
    emoji: "📸",
    blurb: "Conteúdo visual de IA. Menos técnico — curadoria por contas e hashtags.",
    dataKeys: ["instagram"],
    experts: [
      { name: "OpenAI", handle: "@openai", url: "https://www.instagram.com/openai/", note: "Referência de comunicação visual de IA." },
      { name: "#claudeai", handle: "hashtag", url: "https://www.instagram.com/explore/tags/claudeai/", note: "Posts recentes sobre Claude." },
      { name: "#aiagents", handle: "hashtag", url: "https://www.instagram.com/explore/tags/aiagents/", note: "Conteúdo sobre agentes de IA." },
    ],
  },
  {
    id: "forums",
    label: "Fóruns / Google",
    emoji: "💬",
    blurb: "Discussões da comunidade: Reddit, Hacker News e busca no Google.",
    dataKeys: ["reddit", "google", "web"],
    experts: [
      { name: "r/ClaudeAI", handle: "reddit", url: "https://www.reddit.com/r/ClaudeAI/", note: "Comunidade principal de usuários do Claude." },
      { name: "r/Anthropic", handle: "reddit", url: "https://www.reddit.com/r/Anthropic/", note: "Novidades e discussões da Anthropic." },
      { name: "r/LocalLLaMA", handle: "reddit", url: "https://www.reddit.com/r/LocalLLaMA/", note: "LLMs, benchmarks e técnicas." },
      { name: "Hacker News", handle: "news.yc", url: "https://hn.algolia.com/?q=claude", note: "Discussões técnicas profundas (busca: claude)." },
    ],
  },
];
