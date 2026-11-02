import { supabaseAdmin } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";
import { sendFacebookMessage } from "@/lib/facebook";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { getInstagramToken } from "@/lib/ig-token";
import { getFacebookPageToken } from "@/lib/fb-token";
import { stripInternalMarkers } from "@/lib/outbound-text";

// ─── Envio manual pelo painel (o dono digitando) ────────────────────────────
// 02/11/2026: "a plataforma não está dando para enviar mensagem pelo painel".
// Reprodução em produção: a rota do painel mandava a mensagem pelo mesmo
// caminho da IA e, numa conversa do Instagram parada há mais de 24h, o Meta
// recusava com "10: This message is sent outside of allowed window" — e o
// painel NÃO mostrava nada (o fetch ignorava o status, o texto sumia da caixa
// e nenhuma bolha aparecia). Messenger tem a mesma janela de 24h.
//
// Regra da Meta: pela API, a página só responde até 24h depois da ÚLTIMA
// mensagem do cliente. Depois disso só com a etiqueta HUMAN_AGENT (atendimento
// humano, janela de 7 dias) — que é exatamente o caso do painel. Este módulo:
//   1. janela aberta (cliente escreveu há < 24h) → envio normal;
//   2. janela fechada → envio direto com a etiqueta HUMAN_AGENT (sem passar
//      pela função da IA, que dispararia o aviso de "cliente inalcançável");
//   3. envio normal recusado por janela (relógio/latência) → tenta a etiqueta;
//   4. tudo recusado → erro em português para o painel mostrar ao dono.
// WhatsApp (Z-API) não tem janela: segue direto.

export type PanelChannel = "instagram" | "facebook" | "whatsapp";

export type PanelSendResult = {
  ok: boolean;
  channel: PanelChannel;
  // Texto que o cliente de fato recebeu (o Instagram pode derrubar um link).
  sentText?: string;
  via?: "normal" | "human_agent";
  // Mensagem pronta para o dono (português), já com o erro bruto do Meta.
  error?: string;
  rawError?: string;
};

export const META_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function channelOfIgsid(igsid: string): PanelChannel {
  if (igsid.startsWith("wa_")) return "whatsapp";
  if (igsid.startsWith("fb_")) return "facebook";
  return "instagram";
}

// "10: This message is sent outside of allowed window." (IG e Messenger;
// o Messenger às vezes vem como (#10) com subcode 2018278).
export function isMetaWindowError(err: string | undefined | null): boolean {
  if (!err) return false;
  return /^\(?#?10\)?:|\(#10\)/.test(err) || /outside of allowed window|allowed window/i.test(err);
}

const CHANNEL_LABEL: Record<PanelChannel, string> = {
  instagram: "Instagram",
  facebook: "Messenger",
  whatsapp: "WhatsApp",
};

async function lastClientMessageAt(conversationId: string): Promise<Date | null> {
  const { data } = await supabaseAdmin
    .from("instagram_messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1);
  const at = data?.[0]?.created_at;
  return at ? new Date(at) : null;
}

type GraphBody = { message_id?: string; error?: { message?: string; code?: number; error_subcode?: number } };

// Envio direto com a etiqueta HUMAN_AGENT (messaging_type MESSAGE_TAG).
export async function sendWithHumanAgentTag(
  channel: "instagram" | "facebook",
  recipientId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const clean = stripInternalMarkers(text);
  if (!clean) return { ok: false, error: "empty text after marker strip" };
  const payload = JSON.stringify({
    recipient: { id: recipientId },
    message: { text: clean },
    messaging_type: "MESSAGE_TAG",
    tag: "HUMAN_AGENT",
  });
  const url =
    channel === "instagram"
      ? `https://graph.instagram.com/v24.0/me/messages?access_token=${encodeURIComponent(await getInstagramToken())}`
      : `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(await getFacebookPageToken())}`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    const body = (await res.json().catch(() => ({}))) as GraphBody;
    if (!body.error && (body.message_id || res.ok)) {
      console.log(`[PANEL] ${channel} delivered with HUMAN_AGENT tag to ${recipientId}`);
      return { ok: true };
    }
    const err = `${body.error?.code ?? res.status}: ${body.error?.message ?? "unknown"}`;
    console.error(`🚨 [PANEL] ${channel} HUMAN_AGENT send FAILED to ${recipientId}: ${err}`);
    return { ok: false, error: err };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

export function panelErrorMessage(channel: PanelChannel, rawError: string, lastClientAt: Date | null): string {
  const label = CHANNEL_LABEL[channel];
  if (channel !== "whatsapp" && isMetaWindowError(rawError)) {
    const ageH = lastClientAt ? Math.round((Date.now() - lastClientAt.getTime()) / 3_600_000) : null;
    const since = ageH == null ? "" : ageH >= 48 ? ` (a última mensagem dele foi há ${Math.round(ageH / 24)} dias)` : ` (a última mensagem dele foi há ${ageH}h)`;
    // Validado em produção 02/11/2026: a etiqueta HUMAN_AGENT (7 dias) só
    // funciona depois que a Meta aprova a permissão "Human Agent" na revisão
    // do app (developers.facebook.com > App Review). Até lá, só pelo app.
    const needsReview = /reviewed and approved|Human Agent/i.test(rawError);
    const tagNote = needsReview
      ? ` A etiqueta de atendimento humano (que daria 7 dias) ainda não está liberada: o app precisa da permissão "Human Agent" aprovada na App Review da Meta.`
      : ` A Meta também recusou a etiqueta de atendimento humano.`;
    return `O ${label} só deixa a página responder pela API até 24h depois da última mensagem do cliente${since}.${tagNote} Responda pelo app do ${label}. Erro da Meta: ${rawError}`;
  }
  return `Não consegui enviar pelo ${label}. O cliente NÃO recebeu nada. Erro: ${rawError}`;
}

export async function panelSend(params: {
  conversationId: string;
  igsid: string;
  text: string;
}): Promise<PanelSendResult> {
  const { conversationId, igsid, text } = params;
  const channel = channelOfIgsid(igsid);

  if (channel === "whatsapp") {
    const r = await sendWhatsAppMessage(igsid.slice(3), text);
    if (r.ok) return { ok: true, channel, via: "normal" };
    const raw = r.error ?? `HTTP ${r.status}`;
    return { ok: false, channel, rawError: raw, error: panelErrorMessage(channel, raw, null) };
  }

  const recipientId = channel === "facebook" ? igsid.slice(3) : igsid;
  const lastClientAt = await lastClientMessageAt(conversationId);
  const windowOpen = !!lastClientAt && Date.now() - lastClientAt.getTime() < META_WINDOW_MS;

  let raw: string | undefined;
  if (windowOpen) {
    if (channel === "facebook") {
      const r = await sendFacebookMessage(recipientId, text);
      if (r.ok) return { ok: true, channel, via: "normal" };
      raw = r.error ?? "unknown";
    } else {
      const r = await sendInstagramMessage(recipientId, text, { allowLinks: true });
      if (r.ok) return { ok: true, channel, via: "normal", sentText: r.sentText };
      raw = r.error ?? "unknown";
    }
    if (!isMetaWindowError(raw)) {
      return { ok: false, channel, rawError: raw, error: panelErrorMessage(channel, raw, lastClientAt) };
    }
    console.warn(`[PANEL] ${channel} window refused although last client message is recent — trying HUMAN_AGENT`);
  } else {
    console.log(`[PANEL] ${channel} 24h window closed for ${recipientId} — sending with HUMAN_AGENT tag`);
  }

  const tagged = await sendWithHumanAgentTag(channel, recipientId, text);
  if (tagged.ok) return { ok: true, channel, via: "human_agent" };
  // Para o dono, o erro que importa é o da janela (o da etiqueta só o completa).
  const windowRaw = raw ?? "10: This message is sent outside of allowed window.";
  const combined = `${windowRaw} / HUMAN_AGENT: ${tagged.error}`;
  return { ok: false, channel, rawError: combined, error: panelErrorMessage(channel, combined, lastClientAt) };
}
