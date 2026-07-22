import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

// ─── Delivery-failure visibility ────────────────────────────────────────────
// The 2026-07-22 outage: the IG token died and the bot kept "replying" into
// the void for 19 hours — the DB stored every reply, the dashboard showed the
// conversations as answered, and nobody was told. These helpers make a failed
// send IMPOSSIBLE to miss: the owner gets a WhatsApp alert (throttled so a
// dead token doesn't spam a message per client), and the callers stop storing
// replies the client never received.
//
// Throttle state lives in platform_settings row keys (the table has no value
// column): "sendfail|<channel>|<lastAlertISO>".

const ALERT_EVERY_MS = 60 * 60 * 1000; // max 1 owner alert per channel per hour
const OWNER_PHONES = ["15616748334", "556294554477"];

const CHANNEL_LABEL: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook/Messenger",
  whatsapp: "WhatsApp",
};

async function shouldAlert(kind: string, key: string, everyMs: number): Promise<boolean> {
  const prefix = `${kind}|${key}|`;
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("platform")
      .like("platform", `${prefix}%`);
    const rows = (data ?? []).map((r) => String(r.platform));
    const last = rows
      .map((r) => Date.parse(r.slice(prefix.length)))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    if (last && Date.now() - last < everyMs) return false;
    // Claim the slot BEFORE sending (concurrent failures race here; duplicate
    // key insert makes the loser back off).
    const { error } = await supabaseAdmin
      .from("platform_settings")
      .insert({ platform: `${prefix}${new Date().toISOString()}`, paused: false });
    if (error) return false;
    for (const old of rows) {
      await supabaseAdmin.from("platform_settings").delete().eq("platform", old);
    }
    return true;
  } catch (err) {
    console.error("[DELIVERY] throttle check failed:", err);
    return false;
  }
}

// A send to a client failed after retries. Log loudly + alert the owner on
// WhatsApp (the channel that still works) at most once per hour per channel.
export async function reportSendFailure(
  channel: "instagram" | "facebook" | "whatsapp",
  clientId: string,
  errorMsg: string
): Promise<void> {
  console.error(`🚨 [DELIVERY] ${channel} send FAILED for ${clientId}: ${errorMsg}`);
  if (!(await shouldAlert("sendfail", channel, ALERT_EVERY_MS))) return;
  const label = CHANNEL_LABEL[channel] ?? channel;
  const msg = [
    `🚨 OzziFloors - ENTREGA FALHANDO no ${label}!`,
    ``,
    `As respostas do bot NAO estao chegando aos clientes neste canal.`,
    `Erro: ${errorMsg.slice(0, 250)}`,
    `Exemplo de cliente afetado: ${clientId}`,
    ``,
    channel === "instagram"
      ? `Se o erro fala em token/sessao expirada: gere um token novo no Meta e envie para /api/ig-diag?settoken=... (nao precisa de deploy).`
      : `Verifique a conexao do canal no painel.`,
    `Ate resolver, responda os clientes manualmente pelo app.`,
  ].join("\n");
  await Promise.allSettled(OWNER_PHONES.map((p) => sendWhatsAppMessage(p, msg)));
}

const PAUSED_ALERT_EVERY_MS = 6 * 60 * 60 * 1000; // per conversation
const PAUSED_STALE_MS = 60 * 60 * 1000;

// A client wrote into a PAUSED (mode=human) conversation and nobody has
// replied for over an hour — the "Aylen S" black hole (3 days of questions
// into the void on IG). Pings the owner, at most once per 6h per conversation.
// `lastHumanReplyAt` = created_at of the newest assistant/owner message.
export async function alertPausedBacklog(params: {
  conversationId: string;
  channel: "instagram" | "facebook" | "whatsapp";
  clientName: string | null;
  clientId: string;
  lastHumanReplyAt: string | null;
  clientText: string;
}): Promise<void> {
  const { conversationId, channel, clientName, clientId, lastHumanReplyAt, clientText } = params;
  try {
    if (lastHumanReplyAt && Date.now() - Date.parse(lastHumanReplyAt) < PAUSED_STALE_MS) return;
    if (!(await shouldAlert("pausealert", conversationId, PAUSED_ALERT_EVERY_MS))) return;
    const label = CHANNEL_LABEL[channel] ?? channel;
    const msg = [
      `⏸️ OzziFloors - Conversa PAUSADA sem resposta (${label})`,
      ``,
      `Cliente: ${clientName || clientId}`,
      `A IA esta desligada nesta conversa (modo humano) e o cliente continua escrevendo sem ninguem responder ha mais de 1 hora.`,
      ``,
      `Ultima mensagem: ${clientText.slice(0, 200)}`,
      ``,
      `Responda pelo app ou reative a IA no painel.`,
    ].join("\n");
    await Promise.allSettled(OWNER_PHONES.map((p) => sendWhatsAppMessage(p, msg)));
  } catch (err) {
    console.error("[DELIVERY] paused-backlog alert failed:", err);
  }
}
