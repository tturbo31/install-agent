// ─── Pergunta à plataforma ANTES do aviso de véspera (22/10/2026) ────────────
// Caso Dayana (786) 877-0477: o app do Lovable chamou /api/confirmar-instalacao
// com "starts tomorrow, Friday, October 23" para uma cliente sem obra marcada
// (a obra dela já constava concluída na plataforma desde 20/10). A cliente
// respondeu "You have the wrong number". Regra do dono: isso NUNCA pode
// acontecer. Agora o agente pergunta à plataforma, para cada telefone, se o
// cliente tem obra já concluída sem contrato novo depois — se tiver, o aviso
// NÃO sai e o dono é avisado.
//
// FALHA FECHADA: se a plataforma não responder, o aviso também NÃO sai (503 ao
// integrador → o app marca revisão manual; o dono recebe alerta). Diferente da
// trava de duplicidade (fail-open), aqui um aviso errado é o dano grave.
// A regra em si mora na plataforma (lib/instalacao-verificar.ts de lá); aqui só
// se pergunta e se obedece.

export type ObraConcluida = { id: string; data_conclusao: string | null; nome_cliente: string | null };
export type ContratoDepois = { id: string; data_assinatura: string | null };

export type VerificacaoObra =
  | {
      ok: true;
      bloquear: boolean;
      motivo: string | null;
      obra_concluida: ObraConcluida | null;
      contrato_depois: ContratoDepois | null;
      quotes: number;
      jobs: number;
    }
  | { ok: false; erro: string };

const TIMEOUT_MS = 8_000;
const TENTATIVAS = 2;

function endpoint(telefone: string): string {
  const base = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
  return `${base}/api/instalacao/verificar?telefone=${encodeURIComponent(telefone)}`;
}

// Nunca lança. Qualquer coisa que não seja uma resposta 200 bem formada vira
// { ok:false, erro } — e o chamador bloqueia o envio.
export async function verificarObraNaPlataforma(telefone: string): Promise<VerificacaoObra> {
  const token = process.env.PLATAFORMA_WEBHOOK_TOKEN;
  if (!token) return { ok: false, erro: "PLATAFORMA_WEBHOOK_TOKEN ausente" };
  let ultimo = "sem resposta";
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(endpoint(telefone), { headers: { "x-webhook-token": token }, signal: ctrl.signal, cache: "no-store" });
      const texto = await res.text().catch(() => "");
      if (!res.ok) {
        ultimo = `HTTP ${res.status}: ${texto.slice(0, 160)}`;
        console.warn(`[INSTALACAO] verificacao na plataforma tentativa ${tentativa}: ${ultimo}`);
        // 4xx não melhora com retry (token/telefone).
        if (res.status >= 400 && res.status < 500) break;
        continue;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(texto) as Record<string, unknown>;
      } catch {
        ultimo = `resposta nao e JSON: ${texto.slice(0, 80)}`;
        continue;
      }
      if (json?.ok !== true || typeof json.bloquear !== "boolean") {
        ultimo = `resposta inesperada: ${texto.slice(0, 160)}`;
        continue;
      }
      const obra = (json.obra_concluida ?? null) as Partial<ObraConcluida> | null;
      const contrato = (json.contrato_depois ?? null) as Partial<ContratoDepois> | null;
      return {
        ok: true,
        bloquear: json.bloquear,
        motivo: typeof json.motivo === "string" ? json.motivo : null,
        obra_concluida: obra && obra.id ? { id: String(obra.id), data_conclusao: obra.data_conclusao ?? null, nome_cliente: obra.nome_cliente ?? null } : null,
        contrato_depois: contrato && contrato.id ? { id: String(contrato.id), data_assinatura: contrato.data_assinatura ?? null } : null,
        quotes: Array.isArray(json.quotes) ? json.quotes.length : 0,
        jobs: Array.isArray(json.jobs) ? json.jobs.length : 0,
      };
    } catch (err) {
      ultimo = ctrl.signal.aborted ? `timeout ${TIMEOUT_MS}ms` : String(err).slice(0, 160);
      console.warn(`[INSTALACAO] verificacao na plataforma tentativa ${tentativa} falhou: ${ultimo}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, erro: ultimo };
}
