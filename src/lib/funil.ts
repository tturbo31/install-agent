// ─── Funil de atendimento → Ozzi Plataforma ─────────────────────────────────
// Decide QUANDO cada evento do funil dispara, nos 3 canais (Instagram,
// WhatsApp, Messenger), e garante que nada duplica do nosso lado (a plataforma
// ainda deduplica por ig_id e pelos 10 últimos dígitos do telefone).
//
// EVENTOS (spec do dono, 2026-07-11):
//  lead_criado          → primeira mensagem de um contato NOVO (com atribuição
//                         de anúncio via referral CTWA quando houver)
//  conversando          → primeira resposta REAL do cliente (não a cada msg)
//  parou_de_responder   → sem resposta há >24h com a última palavra nossa
//  retomou_conversa     → lead marcado como sumido voltou a falar
//  agendamento_marcado  → visita confirmada/remarcada (data_visita ISO)
//  visita_realizada / no_show → SEM sinal automático hoje (o agendador só
//                         registra cancelamento) — expostos via
//                         funilVisitaResultado() e o endpoint /api/funil-check.
//
// DEDUP SEM TABELA NOVA (o token de gerenciamento do Supabase expirou; DDL
// indisponível — supabase/migrations/002_funil_estado.sql fica como upgrade):
//  • lead_criado/conversando → derivados do próprio histórico de mensagens
//    (determinístico: reprocessar a mesma mensagem chega à mesma decisão);
//  • sumido/retomou → linha própria em platform_settings por conversa
//    ("funil_sumido_<convId>"): INSERT ignoreDuplicates é atômico no PK — quem
//    inseriu ganhou o parou_de_responder, quem deletou ganhou o retomou;
//  • anúncio de origem → "funil_ad_<convId>::<ad_id>::<ad_title>" (a tabela de
//    conversas NÃO tem colunas de anúncio; o update legado falha silencioso);
//  • throttle do sweep de 6h → "funil_check_<epochMs>".
// Tudo chamado via waitUntil (fire-and-forget): NUNCA lança para o atendimento.
import { supabaseAdmin } from "@/lib/supabase";
import { enviarEventoFunil, type EnvioResultado } from "@/lib/plataforma";

export type ConvFunil = { id: string; igsid: string; name?: string | null; username?: string | null; created_at?: string | null };
export type ReferralIG = { ad_id?: string; ads_context_data?: { ad_title?: string; photo_url?: string } } | null;
type MsgRow = { role: string; content: string; created_at: string };

const H = 3600_000;
const SILENCIO_H = 24; // "sem responder há mais de 24h"
const SWEEP_MIN_GAP_H = 6; // cadência do parou_de_responder

// Marco zero do funil: conversas CRIADAS antes desta data nunca receberam
// lead_criado (a feature não existia), então os demais eventos não disparam
// para elas — exceto no agendamento, que faz o backfill do lead na hora.
// O env existe só para os testes simularem históricos retroativos.
function funilDesde(): string {
  return process.env.FUNIL_DESDE || "2026-07-09T19:00:00Z";
}

const stripSys = (c: string) => (c || "").split(/\n\n?\[SYSTEM:/)[0];

export function canalDe(igsid: string): "instagram" | "whatsapp" | "facebook" {
  if (igsid.startsWith("wa_")) return "whatsapp";
  if (igsid.startsWith("fb_")) return "facebook";
  return "instagram";
}

// ─── Telefone ────────────────────────────────────────────────────────────────
// Padrão US (10/11 dígitos) com fronteiras de dígito, + qualquer +E.164. Não
// casa sqft/ZIP/preços (menos de 10 dígitos contíguos por causa dos separadores).
const FONE_US = /(?<!\d)(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(?!\d)/;
const FONE_E164 = /(?<!\d)\+(\d{10,15})(?!\d)/;

export function extrairTelefone(texto: string): string | null {
  const t = stripSys(texto);
  const e164 = t.match(FONE_E164);
  if (e164) return `+${e164[1]}`;
  const us = t.match(FONE_US);
  if (us) return `+1${us[1]}${us[2]}${us[3]}`;
  return null;
}

// Melhor telefone conhecido do contato: no WhatsApp é o próprio número
// (obrigatório); nos outros canais, o primeiro que o cliente digitou.
// `extra` pode ser texto livre (mensagem) OU um telefone cru (booking.phone) —
// só passa adiante se realmente PARECER um telefone; nunca texto de mensagem
// (bug pego no e2e: telefone:"Hi, I want new floors..." foi para a plataforma).
export function telefoneDoContato(igsid: string, msgs: MsgRow[], extra?: string | null): string | null {
  if (igsid.startsWith("wa_")) return `+${igsid.slice(3).replace(/\D/g, "")}`;
  for (const m of msgs) {
    if (m.role !== "user") continue;
    const tel = extrairTelefone(m.content);
    if (tel) return tel;
  }
  if (extra) {
    const tel = extrairTelefone(extra);
    if (tel) return tel;
    const digitos = (extra.match(/\d/g) || []).length;
    if (digitos >= 7 && extra.length <= 25) return extra; // telefone cru (booking.phone)
  }
  return null;
}

// Identificação presente em TODOS os eventos: manda o que tiver.
function identidade(conv: ConvFunil, msgs: MsgRow[], extraFone?: string | null): Record<string, unknown> {
  const canal = canalDe(conv.igsid);
  return {
    // ig_id = id estável do contato (IGSID no Instagram, PSID no Messenger).
    ig_id: canal === "whatsapp" ? undefined : canal === "facebook" ? conv.igsid.slice(3) : conv.igsid,
    ig_username: canal === "instagram" ? conv.username ?? undefined : undefined,
    telefone: telefoneDoContato(conv.igsid, msgs, extraFone) ?? undefined,
  };
}

// ─── data_visita em ISO com fuso de Miami (DST correto) ─────────────────────
export function dataVisitaIso(date: string, time: string): string {
  try {
    const meioDia = new Date(`${date}T12:00:00Z`);
    const partes = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(meioDia);
    const off = partes.find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "-04:00";
    const hhmm = /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, "0") : time;
    return `${date}T${hhmm}:00${off}`;
  } catch {
    return `${date}T${time}:00-04:00`;
  }
}

// ─── Campanha do anúncio (best-effort via Graph API) ─────────────────────────
const campanhaCache = new Map<string, { ad_name: string | null; campanha: string | null }>();

async function buscarDadosAnuncio(adId: string | null | undefined): Promise<{ ad_name: string | null; campanha: string | null }> {
  if (!adId) return { ad_name: null, campanha: null };
  const memo = campanhaCache.get(adId);
  if (memo) return memo;
  const token = process.env.META_ADS_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
  if (!token) return { ad_name: null, campanha: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(adId)}?fields=name,campaign{name}&access_token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    if (!res.ok) return { ad_name: null, campanha: null };
    const j = (await res.json()) as { name?: string; campaign?: { name?: string } };
    const out = { ad_name: j.name ?? null, campanha: j.campaign?.name ?? null };
    campanhaCache.set(adId, out);
    return out;
  } catch {
    return { ad_name: null, campanha: null };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Flags atômicas via platform_settings ────────────────────────────────────
const sumidoKey = (convId: string) => `funil_sumido_${convId}`;
const adKeyPrefix = (convId: string) => `funil_ad_${convId}::`;

// true = ESTA instância criou a flag agora (ganhou o envio do parou_de_responder)
async function marcarSumido(convId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .upsert({ platform: sumidoKey(convId), paused: true }, { ignoreDuplicates: true, onConflict: "platform" })
    .select("platform");
  if (error) { console.warn("[FUNIL] marcarSumido:", error.message); return false; }
  return (data ?? []).length > 0;
}

// true = ESTA instância removeu a flag (ganhou o envio do retomou_conversa)
async function limparSumido(convId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .delete()
    .eq("platform", sumidoKey(convId))
    .select("platform");
  if (error) { console.warn("[FUNIL] limparSumido:", error.message); return false; }
  return (data ?? []).length > 0;
}

async function estaSumido(convId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .eq("platform", sumidoKey(convId))
    .maybeSingle();
  return !!data;
}

// Anúncio de origem persistido na chave (primeiro anúncio vence).
export async function persistirAnuncioDaConversa(convId: string, referral: ReferralIG): Promise<void> {
  try {
    const adId = referral?.ad_id ?? "";
    const adTitle = referral?.ads_context_data?.ad_title ?? "";
    if (!adId && !adTitle) return;
    const { data: existentes } = await supabaseAdmin
      .from("platform_settings")
      .select("platform")
      .like("platform", `${adKeyPrefix(convId)}%`)
      .limit(1);
    if (existentes && existentes.length > 0) return;
    const key = `${adKeyPrefix(convId)}${encodeURIComponent(adId)}::${encodeURIComponent(adTitle).slice(0, 400)}`;
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ platform: key, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });
  } catch (err) {
    console.warn("[FUNIL] persistirAnuncio falhou:", String(err).slice(0, 150));
  }
}

async function dadosDeAnuncioDaConversa(convId: string, referral?: ReferralIG): Promise<{ ad_id: string | null; ad_name: string | null; campanha: string | null }> {
  let adId: string | null = referral?.ad_id ?? null;
  let adName: string | null = referral?.ads_context_data?.ad_title ?? null;
  if (!adId && !adName) {
    try {
      const { data } = await supabaseAdmin
        .from("platform_settings")
        .select("platform")
        .like("platform", `${adKeyPrefix(convId)}%`)
        .limit(1);
      const key = data?.[0]?.platform as string | undefined;
      if (key) {
        const [, rawId, rawTitle] = key.slice("funil_ad_".length).split("::");
        adId = rawId ? decodeURIComponent(rawId) : null;
        adName = rawTitle ? decodeURIComponent(rawTitle) : null;
      }
    } catch { /* sem anúncio persistido */ }
  }
  const graph = await buscarDadosAnuncio(adId);
  // ad_title do referral do webhook é a fonte primária do nome; Graph completa.
  return { ad_id: adId, ad_name: adName ?? graph.ad_name, campanha: graph.campanha };
}

// ─── Histórico auxiliar ──────────────────────────────────────────────────────
async function mensagensDaConversa(convId: string): Promise<MsgRow[]> {
  const { data } = await supabaseAdmin
    .from("instagram_messages")
    .select("role, content, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: true })
    .limit(400);
  return (data ?? []) as MsgRow[];
}

// Botões de FAQ dos anúncios Meta — um toque não é "resposta real".
const FAQ_BUTTON = /^\s*(?:what type of materials are included|what is the installation process|do you offer any discounts for larger spaces|is labor cost also \$?4,?500|can i customize the design|what is included in the materials package|is installation cost included in the price|is installation labor cost extra|schedule a quote)\s*\??\s*$/i;

export function isAdFaqButtonFunil(text: string): boolean {
  return FAQ_BUTTON.test(stripSys(text));
}

// Conversa participa do funil? (criada após o marco zero → lead_criado saiu)
function convNoFunil(conv: ConvFunil): boolean {
  return !!conv.created_at && conv.created_at >= funilDesde();
}

// ─── EVENTOS DE ENTRADA (toda mensagem do cliente, nos 3 canais) ─────────────
// Dispara conforme o caso: lead_criado (1ª mensagem de contato novo, com
// atribuição de anúncio), retomou_conversa (sumido voltou), conversando
// (primeira resposta real). `msgCreatedAt` = created_at da mensagem recém-
// inserida (fronteira do "antes"); `referral` = anúncio CTWA quando houver.
export async function funilOnInboundMessage(conv: ConvFunil, rawText: string, msgCreatedAt: string, referral?: ReferralIG): Promise<void> {
  try {
    if (referral) await persistirAnuncioDaConversa(conv.id, referral);
    if (!convNoFunil(conv)) return; // lead antigo (pré-funil): backfill só no agendamento

    const msgs = await mensagensDaConversa(conv.id);
    const anteriores = msgs.filter((m) => m.created_at < msgCreatedAt);
    const base = identidade(conv, msgs, rawText);

    // 1) LEAD_CRIADO: primeira mensagem de um contato novo. Atribuição do
    // anúncio via referral (CTWA); conversa orgânica omite os campos ad_*.
    if (!anteriores.some((m) => m.role === "user")) {
      const ad = await dadosDeAnuncioDaConversa(conv.id, referral);
      await enviarEventoFunil("lead_criado", {
        ...base,
        nome: conv.name ?? conv.username ?? undefined,
        canal: canalDe(conv.igsid),
        ad_id: ad.ad_id ?? undefined,
        ad_name: ad.ad_name ?? undefined,
        campanha: ad.campanha ?? undefined,
      });
      return;
    }

    // 2) RETOMOU: estava marcado como sumido e voltou a falar. Quem deletar a
    // flag envia; nas demais instâncias/mensagens vira no-op.
    if ((await estaSumido(conv.id)) && (await limparSumido(conv.id))) {
      await enviarEventoFunil("retomou_conversa", base);
      return;
    }

    // 3) CONVERSANDO: primeira resposta REAL do cliente (depois de já termos
    // falado com ele), uma única vez por conversa — nunca a cada mensagem.
    // Um toque de botão de FAQ do anúncio não conta como resposta real.
    const primeiroBot = msgs.findIndex((m) => m.role === "assistant" && m.created_at < msgCreatedAt);
    if (primeiroBot === -1) return; // ainda não respondemos nada
    const jaConversou = anteriores.some(
      (m, i) => m.role === "user" && i > primeiroBot && stripSys(m.content).trim().length > 0 && !isAdFaqButtonFunil(m.content)
    );
    const estaEhReal = stripSys(rawText).trim().length > 0 && !isAdFaqButtonFunil(rawText);
    if (!jaConversou && estaEhReal) {
      await enviarEventoFunil("conversando", base);
    }
  } catch (err) {
    console.warn("[FUNIL] funilOnInboundMessage falhou (atendimento intacto):", String(err).slice(0, 200));
  }
}

// ─── AGENDAMENTO_MARCADO (visita confirmada / remarcada, nos 3 canais) ───────
export async function funilOnBookingConfirmed(
  conversationId: string,
  igsid: string,
  booking: { date?: string; time?: string; phone?: string; name?: string }
): Promise<void> {
  try {
    const { data: convRow } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid, name, username, created_at")
      .eq("id", conversationId)
      .single();
    const conv: ConvFunil = {
      id: conversationId,
      igsid,
      name: (convRow?.name as string | null) ?? null,
      username: (convRow?.username as string | null) ?? null,
      created_at: (convRow?.created_at as string | null) ?? null,
    };
    const msgs = await mensagensDaConversa(conversationId);
    const base = identidade(conv, msgs, booking.phone);

    // Lead antigo (pré-funil) agendou → backfill do lead_criado primeiro, para
    // a plataforma ter o cadastro completo antes do agendamento.
    if (!convNoFunil(conv)) {
      const ad = await dadosDeAnuncioDaConversa(conversationId);
      await enviarEventoFunil("lead_criado", {
        ...base,
        nome: booking.name ?? conv.name ?? conv.username ?? undefined,
        canal: canalDe(igsid),
        ad_id: ad.ad_id ?? undefined,
        ad_name: ad.ad_name ?? undefined,
        campanha: ad.campanha ?? undefined,
      });
    }

    if (!booking.date || !booking.time) return;
    await limparSumido(conversationId); // agendou = não está sumido (sem evento)
    await enviarEventoFunil("agendamento_marcado", {
      ...base,
      data_visita: dataVisitaIso(booking.date, booking.time),
    });
  } catch (err) {
    console.warn("[FUNIL] funilOnBookingConfirmed falhou (atendimento intacto):", String(err).slice(0, 200));
  }
}

// ─── VISITA_REALIZADA / NO_SHOW ──────────────────────────────────────────────
// O agendador NÃO registra o resultado da visita hoje (só cancelamento), então
// não há sinal automático confiável — presumir seria inventar dado. Estes dois
// eventos são disparados sob demanda: pelo endpoint /api/funil-check
// (?visita=realizada|no_show&telefone=...) que o dono, a plataforma ou o app
// de agendamento podem chamar com 1 requisição.
export async function funilVisitaResultado(
  resultado: "realizada" | "no_show",
  ident: { telefone?: string; ig_id?: string }
): Promise<EnvioResultado> {
  const evento = resultado === "realizada" ? "visita_realizada" : "no_show";
  return enviarEventoFunil(evento, {
    telefone: ident.telefone ?? undefined,
    ig_id: ident.ig_id ?? undefined,
  });
}

// ─── PAROU_DE_RESPONDER (sweep, nos 3 canais) ───────────────────────────────
export type SilenceCheckResult = { verificadas: number; disparados: number; detalhes: string[] };

export async function runFunilSilenceCheck(nowMs?: number, onlyConvId?: string): Promise<SilenceCheckResult> {
  const now = nowMs ?? Date.now();
  const out: SilenceCheckResult = { verificadas: 0, disparados: 0, detalhes: [] };
  try {
    const desde = new Date(now - 7 * 24 * H).toISOString();
    let query = supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid, name, username, mode, booking_confirmed, created_at, updated_at")
      .gte("updated_at", desde)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (onlyConvId) query = query.eq("id", onlyConvId); // isolamento nos testes
    const { data: convs } = await query;

    for (const conv of convs ?? []) {
      // Pós-booking o silêncio do bot é intencional; pré-funil não tem lead_criado.
      if (conv.mode !== "agent" || conv.booking_confirmed === true) continue;
      if (!convNoFunil(conv as ConvFunil)) continue;
      out.verificadas++;

      const msgs = await mensagensDaConversa(conv.id);
      if (!msgs.length) continue;
      const ultima = msgs[msgs.length - 1];
      if (ultima.role !== "assistant") continue; // cliente tem a última palavra → não é sumiço
      const ultimaDoCliente = [...msgs].reverse().find((m) => m.role === "user");
      if (!ultimaDoCliente) continue;
      const horas = (now - Date.parse(ultimaDoCliente.created_at)) / H;
      if (horas < SILENCIO_H) continue;

      // Claim atômico: só quem criou a flag envia — 1 único disparo por sumiço.
      if (!(await marcarSumido(conv.id))) continue;
      const envio = await enviarEventoFunil("parou_de_responder", identidade(conv as ConvFunil, msgs));
      out.disparados++;
      // O status HTTP da plataforma fica visível no JSON do /api/funil-check —
      // é a prova observável de que o envio saiu DESTE ambiente (prod/local).
      out.detalhes.push(`${conv.username ?? conv.igsid} (${Math.round(horas)}h) -> HTTP ${envio.status}${envio.ok ? "" : ` (${(envio.body ?? "").slice(0, 60)})`}`);
    }
    console.log(`[FUNIL] silence check: ${out.verificadas} verificadas, ${out.disparados} parou_de_responder`);
  } catch (err) {
    console.warn("[FUNIL] silence check falhou:", String(err).slice(0, 200));
  }
  return out;
}

// Throttle de 6h persistido em platform_settings (época embutida no nome da
// linha). Chamado a cada mensagem recebida — roda o sweep no máximo 4x/dia.
export async function maybeRunFunilSilenceCheck(): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("platform")
      .like("platform", "funil_check_%");
    const marcas = (data ?? []).map((r) => Number(r.platform.replace("funil_check_", ""))).filter(Number.isFinite);
    const ultima = marcas.length ? Math.max(...marcas) : 0;
    if (Date.now() - ultima < SWEEP_MIN_GAP_H * H) return;
    // Troca a marca ANTES de varrer (dupla execução simultânea vira no-op no
    // claim por conversa de qualquer forma).
    for (const m of marcas) await supabaseAdmin.from("platform_settings").delete().eq("platform", `funil_check_${m}`);
    await supabaseAdmin.from("platform_settings").upsert({ platform: `funil_check_${Date.now()}`, paused: false }, { onConflict: "platform" });
    await runFunilSilenceCheck();
  } catch (err) {
    console.warn("[FUNIL] throttle do silence check falhou:", String(err).slice(0, 200));
  }
}
