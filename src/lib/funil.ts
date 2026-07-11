// ─── Funil de atendimento → plataforma de análise ───────────────────────────
// Decide QUANDO cada evento do funil dispara e garante que nada duplica.
// Canal coberto: Instagram (spec do dono, 2026-07-09).
//
// DEDUP SEM TABELA NOVA (o token de gerenciamento do Supabase expirou, então
// DDL não é possível por ora — supabase/migrations/002_funil_estado.sql fica
// como upgrade futuro):
//  • lead_criado / conversando → derivados do próprio histórico de mensagens
//    (determinístico: reprocessar a mesma mensagem chega à mesma decisão);
//  • sumido/retomou → linha própria em platform_settings por conversa
//    ("funil_sumido_<convId>"). O INSERT com ignoreDuplicates é atômico no PK:
//    quem inseriu a linha "ganhou" o direito de enviar parou_de_responder, quem
//    deletou ganhou o retomou_conversa — corrida entre instâncias é impossível.
//    (O GET /api/platform-settings filtra essas linhas para não poluir o painel.)
//  • throttle do sweep de 6h → linha "funil_check_<epochMs>" (época no próprio
//    nome, já que a tabela só tem platform+paused).
// Tudo aqui é fire-and-forget via waitUntil: NUNCA lança para o atendimento.
import { supabaseAdmin } from "@/lib/supabase";
import { enviarEventoFunil } from "@/lib/plataforma";

export type ConvFunil = { id: string; igsid: string; name?: string | null; username?: string | null };
export type ReferralIG = { ad_id?: string; ads_context_data?: { ad_title?: string; photo_url?: string } } | null;
type MsgRow = { role: string; content: string; created_at: string };

const H = 3600_000;
const SILENCIO_H = 24; // "sem responder há mais de 24h"
const SWEEP_MIN_GAP_H = 6; // cadência do parou_de_responder
const CANAL = "instagram";

// Marco zero do funil: telefones capturados ANTES desta data não contam como
// lead_criado (o evento nunca foi enviado — a feature não existia), então
// conversando/parou_de_responder nunca disparam para eles. Evita eventos
// órfãos na plataforma para leads antigos. Se um lead antigo agendar, o
// lead_criado é enviado na hora do agendamento (backfill correto). O env é
// só para os testes conseguirem simular históricos retroativos.
function funilDesde(): string {
  return process.env.FUNIL_DESDE || "2026-07-09T19:00:00Z";
}

const stripSys = (c: string) => (c || "").split(/\n\n?\[SYSTEM:/)[0];

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

// ─── Flag "sumido" atômica via platform_settings ─────────────────────────────
const sumidoKey = (convId: string) => `funil_sumido_${convId}`;

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

// Primeira captura VÁLIDA de telefone (mensagem do cliente, após o marco zero
// do funil). É o "lead_criado já disparou?" derivado do histórico.
function capturaDeTelefone(msgs: MsgRow[]): { telefone: string; at: string } | null {
  const desde = funilDesde();
  for (const m of msgs) {
    if (m.role !== "user" || m.created_at < desde) continue;
    const tel = extrairTelefone(m.content);
    if (tel) return { telefone: tel, at: m.created_at };
  }
  return null;
}

// Qualquer telefone do histórico (inclusive pré-funil) — só para compor payload.
function qualquerTelefone(msgs: MsgRow[]): string | null {
  for (const m of msgs) {
    if (m.role !== "user") continue;
    const tel = extrairTelefone(m.content);
    if (tel) return tel;
  }
  return null;
}

// ─── Persistência do anúncio de origem (sem DDL) ────────────────────────────
// A tabela de conversas NÃO tem colunas de anúncio (o update legado que tentava
// gravá-las falha silencioso desde sempre). O funil persiste o referral numa
// linha técnica de platform_settings com os dados CODIFICADOS NA CHAVE
// ("funil_ad_<convId>::<ad_id>::<ad_title-urlencoded>"), já que a tabela só tem
// platform+paused. Primeira gravação vence; leitura por prefixo.
const adKeyPrefix = (convId: string) => `funil_ad_${convId}::`;

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
    if (existentes && existentes.length > 0) return; // primeiro anúncio vence
    const key = `${adKeyPrefix(convId)}${encodeURIComponent(adId)}::${encodeURIComponent(adTitle).slice(0, 400)}`;
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ platform: key, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });
  } catch (err) {
    console.warn("[FUNIL] persistirAnuncio falhou:", String(err).slice(0, 150));
  }
}

async function dadosDeAnuncioDaConversa(convId: string): Promise<{ ad_id: string | null; ad_name: string | null; campanha: string | null }> {
  let adId: string | null = null;
  let adName: string | null = null;
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
  const graph = await buscarDadosAnuncio(adId);
  // ad_title do referral do webhook é a fonte primária do nome; Graph completa.
  return { ad_id: adId, ad_name: adName ?? graph.ad_name, campanha: graph.campanha };
}

// ─── EVENTOS DE ENTRADA (toda mensagem do cliente no IG) ─────────────────────
// Dispara, conforme o caso: retomou_conversa, lead_criado, conversando.
// `msgCreatedAt` é o created_at da mensagem recém-inserida (fronteira do "antes").
export async function funilOnInboundMessage(conv: ConvFunil, rawText: string, msgCreatedAt: string, referral?: ReferralIG): Promise<void> {
  try {
    if (referral) await persistirAnuncioDaConversa(conv.id, referral);
    const msgs = await mensagensDaConversa(conv.id);
    const anteriores = msgs.filter((m) => m.created_at < msgCreatedAt);
    const captura = capturaDeTelefone(anteriores);
    const telAgora = extrairTelefone(rawText);
    const base = { ig_username: conv.username ?? null, ig_id: conv.igsid };

    // 1) RETOMOU: estava marcado como sumido e voltou a falar. Quem deletar a
    // flag envia; nas demais instâncias/mensagens vira no-op.
    if ((captura || telAgora) && (await estaSumido(conv.id)) && (await limparSumido(conv.id))) {
      await enviarEventoFunil("retomou_conversa", { telefone: captura?.telefone ?? telAgora, ...base });
      return; // retomou já sinaliza atividade — não empilha "conversando" na mesma mensagem
    }

    // 2) LEAD_CRIADO: primeiro telefone da conversa apareceu AGORA.
    if (!captura && telAgora) {
      const ad = await dadosDeAnuncioDaConversa(conv.id);
      await enviarEventoFunil("lead_criado", {
        telefone: telAgora,
        nome: conv.name ?? conv.username ?? null,
        canal: CANAL,
        ...base,
        ad_id: ad.ad_id,
        ad_name: ad.ad_name,
        campanha: ad.campanha,
      });
      return;
    }

    // 3) CONVERSANDO: resposta do lead após o lead_criado — no máximo 1 por
    // 24h, derivado do histórico: só dispara se NENHUMA outra mensagem do
    // cliente posterior à captura do telefone existe nas últimas 24h.
    if (captura) {
      const nowMs = Date.parse(msgCreatedAt);
      const recente = anteriores.some(
        (m) => m.role === "user" && m.created_at > captura.at && nowMs - Date.parse(m.created_at) < 24 * H
      );
      if (!recente) {
        await enviarEventoFunil("conversando", { telefone: captura.telefone, ...base });
      }
    }
  } catch (err) {
    console.warn("[FUNIL] funilOnInboundMessage falhou (atendimento intacto):", String(err).slice(0, 200));
  }
}

// ─── AGENDAMENTO_MARCADO (visita confirmada / remarcada) ─────────────────────
export async function funilOnBookingConfirmed(
  conversationId: string,
  igsid: string,
  booking: { date?: string; time?: string; phone?: string; name?: string }
): Promise<void> {
  try {
    const { data: conv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid, name, username")
      .eq("id", conversationId)
      .single();
    const base = { ig_username: (conv?.username as string | null) ?? null, ig_id: igsid };
    const msgs = await mensagensDaConversa(conversationId);
    const captura = capturaDeTelefone(msgs);
    const telefone =
      captura?.telefone ??
      (booking.phone ? extrairTelefone(booking.phone) ?? booking.phone : null) ??
      qualquerTelefone(msgs);

    // Garantia: agendou sem o lead_criado ter saído (telefone só existiu no
    // JSON do booking) → cria o lead primeiro para a plataforma ter o registro.
    if (!captura && telefone) {
      const ad = await dadosDeAnuncioDaConversa(conversationId);
      await enviarEventoFunil("lead_criado", {
        telefone,
        nome: booking.name ?? (conv?.name as string | null) ?? (conv?.username as string | null) ?? null,
        canal: CANAL,
        ...base,
        ad_id: ad.ad_id,
        ad_name: ad.ad_name,
        campanha: ad.campanha,
      });
    }

    if (!booking.date || !booking.time) return;
    await limparSumido(conversationId); // agendou = não está sumido (sem evento)
    await enviarEventoFunil("agendamento_marcado", {
      telefone,
      data_visita: dataVisitaIso(booking.date, booking.time),
      ...base,
    });
  } catch (err) {
    console.warn("[FUNIL] funilOnBookingConfirmed falhou (atendimento intacto):", String(err).slice(0, 200));
  }
}

// ─── PAROU_DE_RESPONDER (sweep) ──────────────────────────────────────────────
export type SilenceCheckResult = { verificadas: number; disparados: number; detalhes: string[] };

export async function runFunilSilenceCheck(nowMs?: number, onlyConvId?: string): Promise<SilenceCheckResult> {
  const now = nowMs ?? Date.now();
  const out: SilenceCheckResult = { verificadas: 0, disparados: 0, detalhes: [] };
  try {
    const desde = new Date(now - 7 * 24 * H).toISOString();
    let query = supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid, name, username, mode, booking_confirmed, updated_at")
      .gte("updated_at", desde)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (onlyConvId) query = query.eq("id", onlyConvId); // isolamento nos testes
    const { data: convs } = await query;

    for (const conv of convs ?? []) {
      // Só Instagram (spec); pós-booking o silêncio do bot é intencional.
      if (conv.igsid.startsWith("wa_") || conv.igsid.startsWith("fb_")) continue;
      if (conv.mode !== "agent" || conv.booking_confirmed === true) continue;
      out.verificadas++;

      const msgs = await mensagensDaConversa(conv.id);
      if (!msgs.length) continue;
      const captura = capturaDeTelefone(msgs); // lead_criado já disparou?
      if (!captura) continue;
      const ultima = msgs[msgs.length - 1];
      if (ultima.role !== "assistant") continue; // cliente tem a última palavra → não é sumiço
      const ultimaDoCliente = [...msgs].reverse().find((m) => m.role === "user");
      if (!ultimaDoCliente) continue;
      const horas = (now - Date.parse(ultimaDoCliente.created_at)) / H;
      if (horas < SILENCIO_H) continue;

      // Claim atômico: só quem criou a flag envia — 1 único disparo por sumiço.
      if (!(await marcarSumido(conv.id))) continue;
      const envio = await enviarEventoFunil("parou_de_responder", {
        telefone: captura.telefone,
        ig_username: conv.username ?? null,
        ig_id: conv.igsid,
        horas_sem_resposta: Math.round(horas),
      });
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
