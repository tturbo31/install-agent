// ─── Ponte com a Ozzi Plataforma (funil de vendas) ──────────────────────────
// Envia eventos do funil de atendimento via webhook autenticado. REGRA DE OURO:
// esta função NUNCA pode derrubar ou atrasar o atendimento — todo erro é
// engolido e logado; se a plataforma cair, o bot segue conversando normalmente.
// Contrato (spec do dono, 2026-07-11): timeout 5s, até 2 retries em falha de
// rede/5xx, e na falha total o PAYLOAD COMPLETO é logado para reenvio manual.
// A resposta de erro da plataforma é JSON dizendo qual campo faltou — sempre
// logada quando o status não é 200.

export type EventoFunil =
  | "lead_criado"
  | "conversando"
  | "parou_de_responder"
  | "retomou_conversa"
  | "agendamento_marcado"
  | "visita_realizada"
  | "no_show"
  | "followup_respondeu"; // cliente de follow-up de orçamento respondeu → plataforma encerra a cadência

export type EnvioResultado = { ok: boolean; status: number; body?: string };

const TIMEOUT_MS = 5_000;
const TENTATIVAS = 3; // 1 envio + 2 retries
const RETRY_DELAY_MS = 1_000;

function endpoint(): string {
  const base = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
  return `${base}/api/webhooks/atendimento`;
}

// POST com timeout de 5s e 2 retries. Nunca lança: sempre resolve com o resultado.
export async function enviarEventoFunil(
  evento: EventoFunil,
  dados: Record<string, unknown>
): Promise<EnvioResultado> {
  const token = process.env.PLATAFORMA_WEBHOOK_TOKEN;
  // Campos undefined/null ficam FORA do payload (conversa orgânica omite ad_*).
  const payload: Record<string, unknown> = { evento };
  for (const [k, v] of Object.entries(dados)) {
    if (v !== undefined && v !== null && v !== "") payload[k] = v;
  }
  const json = JSON.stringify(payload);
  const resumo = JSON.stringify({ ig_id: dados.ig_id, telefone: dados.telefone }).slice(0, 110);

  if (!token) {
    console.warn(`[FUNIL] ${evento} NAO enviado — PLATAFORMA_WEBHOOK_TOKEN ausente | payload para reenvio manual: ${json}`);
    return { ok: false, status: 0, body: "token ausente" };
  }

  let ultimo: EnvioResultado = { ok: false, status: 0 };
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-token": token },
        body: json,
        signal: ctrl.signal,
      });
      const body = (await res.text().catch(() => "")).slice(0, 300);
      ultimo = { ok: res.ok, status: res.status, body };
      if (res.ok) {
        console.log(`[FUNIL] ${evento} -> HTTP ${res.status} (tentativa ${tentativa}) | ${resumo} | resposta: ${body.slice(0, 140) || "(vazia)"}`);
        return ultimo;
      }
      // A plataforma responde JSON dizendo qual campo faltou — logar SEMPRE.
      console.warn(`[FUNIL] ${evento} -> HTTP ${res.status} (tentativa ${tentativa}) | erro da plataforma: ${body}`);
      // 4xx é payload/token errado — retry não resolve, para aqui.
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      ultimo = { ok: false, status: 0, body: String(err).slice(0, 200) };
      console.warn(`[FUNIL] ${evento} falhou (tentativa ${tentativa}): ${String(err).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
    }
    if (tentativa < TENTATIVAS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * tentativa));
  }
  // Falha total: payload COMPLETO no log para reenvio manual (spec do dono).
  console.error(`[FUNIL] ${evento} PERDIDO apos ${TENTATIVAS} tentativas — atendimento segue normal. Payload para reenvio manual: ${json}`);
  return ultimo;
}
