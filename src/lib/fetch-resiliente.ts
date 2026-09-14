// FETCH COM RETENTATIVA PARA O SUPABASE — 14/09/2026
//
// Na rodada das 9h de 14/09 o banco respondeu "Gateway Timeout" para a leitura
// de leads em CINCO consertos seguidos (fusão de gêmeos, telefone inválido,
// unificação de identidade, post do anúncio, quotes órfãos), o agente respondeu
// 500 nos dois endpoints que também leem banco, e a rodada saiu com "ok: true"
// e 15 problemas — nenhum conserto rodou e a próxima chance era 8 horas
// depois. A instância é pequena (60 conexões) e às 9h da Flórida concorrem o
// Maestro do cron da manhã, o painel do dono e a própria auditoria: uma leitura
// que falha por 5 segundos de fila não pode derrubar a rodada inteira.
//
// Só GET/HEAD são repetidos: leitura é idempotente. INSERT/UPDATE/RPC (POST/
// PATCH) nunca são repetidos aqui — repetir um insert cujo resultado se perdeu
// duplica linha (é exatamente o que o agente fazia com o timeout de 5s no
// agendamento_marcado: 3 pares de visitas gêmeas em setembro). Cada tentativa
// tem teto de tempo próprio: a rodada tem orçamento de 210s e uma requisição
// pendurada não pode comê-lo.
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const STATUS_TRANSITORIOS = new Set([408, 425, 429, 500, 502, 503, 504]);
const ESPERAS_MS = [1_500, 4_000];

/** A mensagem de erro é de banco/rede instável (vale repetir), não de dado errado. */
export function ehErroTransitorio(mensagem: string | null | undefined): boolean {
  return /gateway timeout|timed out|tempo esgotado|timeout|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|aborted|PGRST003|PGRST303|too many connections|connection pool|respondeu 5\d\d|HTTP 5\d\d/i.test(
    mensagem ?? ""
  );
}

async function precisaRepetir(res: Response): Promise<boolean> {
  if (STATUS_TRANSITORIOS.has(res.status)) return true;
  // 401 "JWT issued at future" (PGRST303) é o relógio do gateway adiantado por
  // um instante — visto em 1 de 12 leituras paralelas em 14/09; a chave é a
  // mesma e a leitura seguinte passa.
  if (res.status === 401) {
    const corpo = await res
      .clone()
      .text()
      .catch(() => "");
    return /PGRST303/.test(corpo);
  }
  return false;
}

export function fetchResiliente(opcoes?: { timeoutMs?: number; tentativas?: number }): FetchLike {
  const timeoutMs = opcoes?.timeoutMs ?? 40_000;
  const tentativas = Math.max(1, opcoes?.tentativas ?? 3);
  return async (input, init) => {
    const metodo = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const idempotente = metodo === "GET" || metodo === "HEAD";
    const max = idempotente ? tentativas : 1;
    const sinalExterno = init?.signal ?? undefined;
    let ultimoErro: unknown = null;
    for (let t = 1; t <= max; t++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error(`tempo esgotado (${timeoutMs}ms)`)), timeoutMs);
      const encaminhar = () => ctrl.abort(sinalExterno?.reason);
      if (sinalExterno?.aborted) encaminhar();
      else sinalExterno?.addEventListener("abort", encaminhar, { once: true });
      try {
        const res = await fetch(input, { ...init, signal: ctrl.signal });
        if (t === max || !(await precisaRepetir(res))) return res;
        ultimoErro = new Error(`HTTP ${res.status}`);
      } catch (e) {
        ultimoErro = e;
        if (sinalExterno?.aborted || t === max) throw e;
      } finally {
        clearTimeout(timer);
        sinalExterno?.removeEventListener("abort", encaminhar);
      }
      await new Promise((r) => setTimeout(r, ESPERAS_MS[t - 1] ?? 4_000));
    }
    throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro));
  };
}
