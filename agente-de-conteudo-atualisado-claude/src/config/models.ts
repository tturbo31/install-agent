/**
 * Configuração central de modelos e custo (AAR #1, #2, #3).
 *
 * - Model tiering (#3): use MODEL_DEEP para raciocínio pesado (análise estruturada,
 *   visão) e MODEL_LIGHT para tarefas mais simples (análise por vídeo, resumo, dedupe).
 * - Batch API (#2): quando USE_BATCH_API=true, o job diário envia a análise em lote
 *   (50% mais barato, assíncrono). Mantém o caminho síncrono como padrão para o
 *   relatório ficar pronto na hora e dentro do timeout do GitHub Action.
 * - Prompt caching (#1) é aplicado nos próprios serviços via cache_control.
 *
 * Tudo é sobrescrevível por variável de ambiente — basta setar no .env / secrets.
 */

function envStr(name: string, fallback: string): string {
  const v = process.env[name]?.trim()
  return v && v.length > 0 ? v : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  if (v === undefined || v === "") return fallback
  return v === "true" || v === "1" || v === "yes"
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]?.trim())
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** Modelo para raciocínio pesado: análise estruturada final, visão. */
export const MODEL_DEEP = envStr("MODEL_DEEP", "claude-opus-4-8")

/** Modelo para tarefas mais leves: análise por vídeo, resumos, classificação. */
export const MODEL_LIGHT = envStr("MODEL_LIGHT", "claude-sonnet-4-6")

/** Liga o caminho Batch API (−50%) para o job diário. Padrão: desligado. */
export const USE_BATCH_API = envBool("USE_BATCH_API", false)

/** Espera máxima (ms) ao aguardar um batch terminar antes de desistir. */
export const BATCH_MAX_WAIT_MS = envNum("BATCH_MAX_WAIT_MS", 20 * 60 * 1000)

/** Intervalo de polling (ms) ao checar o status do batch. */
export const BATCH_POLL_INTERVAL_MS = envNum("BATCH_POLL_INTERVAL_MS", 15_000)

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
