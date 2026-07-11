// ─── Ponte com a plataforma de análise (ozzi-plataforma) ────────────────────
// Envia eventos do funil de atendimento via webhook autenticado. REGRA DE OURO:
// esta função NUNCA pode derrubar ou atrasar o atendimento — todo erro é
// engolido e logado; se a plataforma cair, o bot segue conversando normalmente.

export type EventoFunil =
  | "lead_criado"
  | "conversando"
  | "agendamento_marcado"
  | "parou_de_responder"
  | "retomou_conversa";

export type EnvioResultado = { ok: boolean; status: number; body?: string };

const TIMEOUT_MS = 5_000;

function endpoint(): string {
  const base = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
  return `${base}/api/webhooks/atendimento`;
}

// POST com timeout de 5s e 1 retry. Nunca lança: sempre resolve com o resultado.
export async function enviarEventoFunil(
  evento: EventoFunil,
  dados: Record<string, unknown>
): Promise<EnvioResultado> {
  const token = process.env.PLATAFORMA_WEBHOOK_TOKEN;
  const resumo = JSON.stringify({ telefone: dados.telefone, ig_username: dados.ig_username }).slice(0, 120);
  if (!token) {
    console.warn(`[FUNIL] ${evento} NAO enviado — PLATAFORMA_WEBHOOK_TOKEN ausente | ${resumo}`);
    return { ok: false, status: 0, body: "token ausente" };
  }

  const payload = JSON.stringify({ evento, ...dados, enviado_em: new Date().toISOString() });
  let ultimo: EnvioResultado = { ok: false, status: 0 };

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-token": token },
        body: payload,
        signal: ctrl.signal,
      });
      const body = (await res.text().catch(() => "")).slice(0, 200);
      ultimo = { ok: res.ok, status: res.status, body };
      console.log(`[FUNIL] ${evento} -> HTTP ${res.status} (tentativa ${tentativa}) | ${resumo} | resposta: ${body.slice(0, 120) || "(vazia)"}`);
      if (res.ok) return ultimo;
      // 4xx não melhora com retry (token errado / payload rejeitado) — para aqui.
      if (res.status >= 400 && res.status < 500) return ultimo;
    } catch (err) {
      ultimo = { ok: false, status: 0, body: String(err).slice(0, 200) };
      console.warn(`[FUNIL] ${evento} falhou (tentativa ${tentativa}): ${String(err).slice(0, 120)} | ${resumo}`);
    } finally {
      clearTimeout(timer);
    }
    if (tentativa === 1) await new Promise((r) => setTimeout(r, 800));
  }
  console.error(`[FUNIL] ${evento} PERDIDO apos retry — atendimento segue normal | ${resumo}`);
  return ultimo;
}
