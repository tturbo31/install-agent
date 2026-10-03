// ─── Comentário em post/anúncio do Facebook → resposta privada (I/O) ─────────
// Caso e regras em post-comment-policy.ts (Joshua Gray, 03/10/2026). Dois
// caminhos chegam aqui e se deduplicam pela mesma trava (fbcmt|<comment_id>):
//
//   1. VARREDURA (funciona hoje, sem assinatura nenhuma): no tráfego dos 3
//      webhooks, no máximo 1 a cada 3 min, lê os posts de anúncio e do feed cujo
//      updated_time (sobe a cada comentário novo) caiu na janela de 7 dias e os
//      comentários de 1º nível deles, num lote só.
//   2. WEBHOOK `feed` (entry[].changes): tempo real, quando a página assinar o
//      campo — exige um page token com pages_manage_metadata, que o atual não
//      tem, e o campo marcado no app da Meta.
//
// Cada comentário novo: classifica (Haiku) → lead / critique / skip → compõe →
// UMA resposta privada → grava a conversa fb_<PSID> com o comentário + a
// resposta, para o fluxo normal do Messenger continuar quando a pessoa responder.
import { supabaseAdmin } from "@/lib/supabase";
import { getFacebookPageToken } from "@/lib/fb-token";
import { getAdsToken } from "@/lib/ads-token";
import { sendFacebookPrivateReply, fetchFacebookProfile } from "@/lib/facebook";
import { notifyOwners } from "@/lib/whatsapp";
import { shouldAlert } from "@/lib/delivery";
import {
  getAIResponse,
  classifyPostComment,
  composeCommentCritiqueReply,
  stripForbiddenTags,
  redirectOwnerPromiseToPhone,
  promisesOwnerContact,
  detectAdFlooringType,
  adFlooringTypeNote,
  repairVisitOfferLeak,
  unsupportedFloorLeak,
  unsupportedFloorReply,
  mobileHomeLeak,
  portStLucieLeak,
  portStLucieStanding,
  portStLucieAskPhone,
  smallJobLeak,
  smallJobReply,
  bathroomLeak,
  bathroomReply,
  PORT_ST_LUCIE_ALERT,
} from "@/lib/ai";
import {
  detectLang,
  getEasternDateContext,
  getRealAvailabilityContext,
  reconcileOfferedDates,
  repairDeclineMessage,
  mobileHomeDeclineMessage,
  portStLucieHandoffMessage,
} from "@/lib/scheduler";
import { AD_REPLY_NOTE } from "@/lib/system-prompt";
import { loadGlobalCorrections } from "@/lib/corrections";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { funilOnInboundMessage } from "@/lib/funil";
import {
  COMMENT_MAX_CLASSIFIED_PER_SWEEP,
  COMMENT_MAX_PER_SWEEP,
  COMMENT_POST_LOOKBACK_MS,
  COMMENT_SWEEP_GAP_MS,
  commentEligibility,
  commentLeadNote,
  commentLookupPrefix,
  commentTextMatches,
  commentThreadBlockReason,
  commentStoredText,
  commentsFromWebhookBody,
  critiqueFallbackReply,
  firstNameOf,
  shouldReplyToClass,
  type CommentClass,
  type CommentSource,
  type PostComment,
} from "@/lib/post-comment-policy";

const GRAPH = "https://graph.facebook.com/v24.0";
const CLAIM_PREFIX = "fbcmt|";
const RESULT_PREFIX = "fbcmt-result|";
// Falha "retryable" da Meta devolve o comentário para a próxima varredura, até
// este total de falhas (cada tentativa gera a resposta de novo).
const MAX_SEND_FAILURES = 3;
// Erro de permissão/token na resposta privada = canal bloqueado: a varredura
// recua por BLOCK_BACKOFF_MS (linha fbcmt-blocked|<iso>).
const CHANNEL_BLOCK_CODES = new Set([3, 10, 190, 200]);
const BLOCKED_PREFIX = "fbcmt-blocked|";
const BLOCK_BACKOFF_MS = 60 * 60_000;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]).catch(() => null);

// ─── Token de LEITURA ───────────────────────────────────────────────────────
// ads_posts (os posts de anúncio, onde mora quase todo comentário) exige
// pages_manage_ads, que o page token do Messenger não tem. O token de anúncios
// (usuário, adstok|… em platform_settings, conferido em 03/10: pages_read_
// engagement + pages_read_user_content + pages_manage_ads) devolve via
// /me/accounts o page token derivado que lê tudo, inclusive can_reply_privately.
// Sem ele, só o feed orgânico, com o page token do Messenger. O ENVIO é sempre
// com o page token do Messenger (pages_messaging).
type Reader = { token: string; ads: boolean };
const READER_TTL_MS = 30 * 60_000;
let readerCache: (Reader & { at: number }) | null = null;

async function commentReader(pageId: string): Promise<Reader | null> {
  if (readerCache && Date.now() - readerCache.at < READER_TTL_MS) return readerCache;
  let reader: Reader | null = null;
  try {
    const adsTok = await getAdsToken();
    if (adsTok) {
      const r = await fetch(`${GRAPH}/me/accounts?fields=id,access_token&limit=100&access_token=${encodeURIComponent(adsTok)}`);
      const b = (await r.json().catch(() => ({}))) as { data?: Array<{ id?: string; access_token?: string }> };
      const tok = b.data?.find((a) => a.id === pageId)?.access_token;
      if (tok) reader = { token: tok, ads: true };
    }
  } catch (err) {
    console.warn("[COMMENTS] ads-derived page token unavailable:", String(err).slice(0, 150));
  }
  if (!reader) {
    const pageTok = await getFacebookPageToken();
    if (pageTok) reader = { token: pageTok, ads: false };
  }
  if (reader) readerCache = { ...reader, at: Date.now() };
  return reader;
}

async function graphGet<T>(pathAndQuery: string, token: string): Promise<T | null> {
  try {
    const sep = pathAndQuery.includes("?") ? "&" : "?";
    const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${GRAPH}/${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const body = (await res.json().catch(() => null)) as (T & { error?: { code?: number; message?: string } }) | null;
    if (!body || body.error) {
      console.warn(`[COMMENTS] graph ${pathAndQuery.split("?")[0].slice(0, 60)} failed:`, JSON.stringify(body?.error ?? res.status).slice(0, 200));
      return null;
    }
    return body;
  } catch (err) {
    console.warn("[COMMENTS] graph fetch threw:", String(err).slice(0, 150));
    return null;
  }
}

type ActivePost = { id: string; source: CommentSource; text: string | null };

// Posts com comentário novo na janela: updated_time sobe a cada comentário
// (conferido em 03/10: o post do Joshua foi para 04:40:38, a hora do comentário).
async function listActivePosts(reader: Reader, pageId: string, nowMs: number): Promise<ActivePost[]> {
  const since = nowMs - COMMENT_POST_LOOKBACK_MS;
  const out = new Map<string, ActivePost>();
  type Page = { data?: Array<{ id?: string; updated_time?: string; message?: string; description?: string }>; paging?: { next?: string } };
  const take = (rows: Page["data"], source: CommentSource) => {
    for (const p of rows ?? []) {
      if (!p.id || !p.updated_time || Date.parse(p.updated_time) < since) continue;
      if (!out.has(p.id)) out.set(p.id, { id: p.id, source, text: p.message ?? p.description ?? null });
    }
  };
  if (reader.ads) {
    let next: string | null = `${pageId}/ads_posts?fields=id,updated_time,message&limit=100&include_inline_create=true`;
    for (let i = 0; i < 8 && next; i++) {
      const page: Page | null = await graphGet<Page>(next, reader.token);
      if (!page) break;
      take(page.data, "ad");
      next = page.paging?.next ?? null;
    }
  }
  const feed = await graphGet<Page>(`${pageId}/feed?fields=id,updated_time,message&limit=50`, reader.token);
  take(feed?.data, "post");
  const reels = await graphGet<Page>(`${pageId}/video_reels?fields=id,updated_time,description&limit=25`, reader.token);
  take(reels?.data, "post");
  return [...out.values()];
}

// Comentários de 1º nível dos posts ativos, em lotes de 50 (?ids=) por origem:
// um id que a Graph recusa derruba o lote inteiro, então anúncio, feed e reels
// não se misturam. O mesmo comentário aparece sob vários posts de anúncio (o
// mesmo criativo em vários conjuntos) — um só por id.
async function fetchTopLevelComments(token: string, posts: ActivePost[]): Promise<PostComment[]> {
  const byId = new Map<string, PostComment>();
  const fields = encodeURIComponent(
    "comments.filter(toplevel).order(reverse_chronological).limit(25){id,message,created_time,from{id,name},can_reply_privately}"
  );
  const chunks: ActivePost[][] = [];
  for (const source of ["ad", "post"] as const) {
    const ofSource = posts.filter((p) => p.source === source);
    for (let i = 0; i < ofSource.length; i += 50) chunks.push(ofSource.slice(i, i + 50));
  }
  for (const chunk of chunks) {
    type Batch = Record<string, { comments?: { data?: Array<{ id?: string; message?: string; created_time?: string; from?: { id?: string; name?: string }; can_reply_privately?: boolean }> } }>;
    const b = await graphGet<Batch>(`?ids=${chunk.map((p) => p.id).join(",")}&fields=${fields}`, token);
    if (!b) continue;
    for (const post of chunk) {
      for (const cm of b[post.id]?.comments?.data ?? []) {
        if (!cm.id || byId.has(cm.id)) continue;
        byId.set(cm.id, {
          id: cm.id,
          postId: post.id,
          message: cm.message ?? "",
          createdTime: cm.created_time ? new Date(Date.parse(cm.created_time)).toISOString() : "",
          source: post.source,
          fromId: cm.from?.id ?? null,
          fromName: cm.from?.name ?? null,
          parentId: null,
          canReplyPrivately: typeof cm.can_reply_privately === "boolean" ? cm.can_reply_privately : null,
          postText: post.text,
        });
      }
    }
  }
  return [...byId.values()];
}

// ─── Trava, resultado, pausa ────────────────────────────────────────────────
// platform_settings.platform é único: o INSERT é a trava (mesmo padrão do
// claimSendOnce). Varredura e webhook nunca respondem o mesmo comentário 2x.
async function claimComment(commentId: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("platform_settings").insert({ platform: `${CLAIM_PREFIX}${commentId}`, paused: false });
  return !error;
}

async function releaseComment(commentId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("platform_settings").delete().eq("platform", `${CLAIM_PREFIX}${commentId}`);
  if (error) console.error("[COMMENTS] release claim failed:", error.message);
}

// Linhas de auditoria (os logs da Vercel não ficam à mão numa investigação):
// fbcmt-result|<resultado>|<iso>|<comment_id>
async function recordOutcome(commentId: string, outcome: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("platform_settings")
      .insert({ platform: `${RESULT_PREFIX}${outcome}|${new Date().toISOString()}|${commentId}`.slice(0, 250), paused: false });
  } catch {
    /* best-effort */
  }
}

async function priorSendFailures(commentId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .like("platform", `${RESULT_PREFIX}send-failed|%|${commentId}`);
  return error ? MAX_SEND_FAILURES : (data ?? []).length;
}

// Ids já travados. null = leitura falhou: nunca tratar como "ninguém travou"
// (responderia de novo quem já recebeu).
async function claimedCommentIds(ids: string[]): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const keys = ids.slice(i, i + 50).map((id) => `${CLAIM_PREFIX}${id}`);
    const { data, error } = await supabaseAdmin.from("platform_settings").select("platform").in("platform", keys);
    if (error) {
      console.warn("[COMMENTS] claim read failed, skipping sweep:", error.message);
      return null;
    }
    for (const r of data ?? []) out.add(String(r.platform).slice(CLAIM_PREFIX.length));
  }
  return out;
}

// Bloqueio recente do canal (erro de permissão na última hora). Limpa as
// linhas velhas de passagem.
async function channelBlockedRecently(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `${BLOCKED_PREFIX}%`);
  if (error) return false;
  let recent = false;
  for (const r of data ?? []) {
    const key = String(r.platform);
    const at = Date.parse(key.slice(BLOCKED_PREFIX.length));
    if (Number.isFinite(at) && Date.now() - at < BLOCK_BACKOFF_MS) recent = true;
    else await supabaseAdmin.from("platform_settings").delete().eq("platform", key);
  }
  return recent;
}

async function facebookPaused(): Promise<boolean> {
  const { data } = await supabaseAdmin.from("platform_settings").select("paused").eq("platform", "facebook").maybeSingle();
  return !!data?.paused;
}

// Webhook: o evento não diz se o post é anúncio. Post de anúncio é "dark post"
// (is_published false); o texto do post entra na nota do cérebro.
async function postInfo(postId: string): Promise<{ text: string | null; isAd: boolean }> {
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
  const reader = await commentReader(pageId);
  if (!reader) return { text: null, isAd: false };
  const p = await graphGet<{ message?: string; is_published?: boolean }>(`${postId}?fields=message,is_published`, reader.token);
  return { text: p?.message ?? null, isAd: p?.is_published === false };
}

// ─── Quem comentou já tem conversa? ─────────────────────────────────────────
// A Meta oculta o autor do comentário, mas o comentário de quem já tem thread
// chega nela como bolha (webhook) e o "chat" criado por comentário chega pela
// rede de mensagem perdida. Acha essa bolha pelo começo do texto, numa janela
// a partir do comentário, e devolve a conversa + o histórico depois dele.
export async function findThreadWithComment(c: PostComment) {
  const prefix = commentLookupPrefix(c.message);
  if (!prefix) return null;
  const at = Date.parse(c.createdTime);
  const like = prefix.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data: hits, error } = await supabaseAdmin
    .from("instagram_messages")
    .select("conversation_id, content, instagram_msg_id")
    .eq("role", "user")
    .ilike("content", `${like}%`)
    .gte("created_at", new Date(at - 10 * 60_000).toISOString())
    .limit(20);
  if (error) throw new Error(`thread lookup failed: ${error.message}`);
  const hit = (hits ?? []).find((h) => !String(h.instagram_msg_id ?? "").startsWith("fbcmt_") && commentTextMatches(h.content, c.message));
  if (!hit) return null;
  const { data: conv } = await supabaseAdmin
    .from("instagram_conversations")
    .select("id, igsid, mode, booking_confirmed")
    .eq("id", hit.conversation_id)
    .maybeSingle();
  if (!conv || !String(conv.igsid).startsWith("fb_")) return null;
  const { data: rows } = await supabaseAdmin
    .from("instagram_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(40);
  return { conv, rows: rows ?? [] };
}

// ─── Composição ─────────────────────────────────────────────────────────────
type Composed = { text: string; notify: boolean; alert: string | null };

// LEAD: o mesmo cérebro do Messenger, como 1º contato de anúncio (aberturas
// enlatadas, regras de preço, de área, de reparo...), com a nota do comentário
// no turno. Booking não existe aqui (sem endereço nem telefone): [BOOK] sai.
async function composeLeadReply(c: PostComment, stored: string, lang: "en" | "es" | "pt"): Promise<Composed | null> {
  const history = [{ role: "user", content: stored }];
  const availability = await withTimeout(getRealAvailabilityContext({ history }), 8000);
  const parts: string[] = [getEasternDateContext()];
  if (availability) parts.push(availability);
  const adType = detectAdFlooringType(c.postText ?? null);
  if (adType) parts.push(adFlooringTypeNote(adType));
  else if (c.source === "ad") parts.push(AD_REPLY_NOTE);
  parts.push(commentLeadNote(c, Date.now()));
  const messages = [{ role: "user" as const, content: `${stored}\n\n[SYSTEM: ${parts.join("\n\n")}]`, at: new Date().toISOString() }];
  const [systemMemory, corrections] = await Promise.all([
    process.env.ANTHROPIC_API_KEY ? withTimeout(getOrCreateSystemStore().then((id) => readSystemMemory(id)), 3000) : Promise.resolve(null),
    withTimeout(loadGlobalCorrections(), 3000),
  ]);
  const ai = await getAIResponse(messages, null, systemMemory, corrections, false);
  let text = (ai.text ?? "")
    .replace(/\[REACT_ONLY\]/gi, "")
    .replace(/\[BOOK:[\s\S]*?\]/g, "")
    .replace(/\[CANCEL_BOOKING\]/gi, "")
    .trim();
  if (!text) return null;
  const fixed = reconcileOfferedDates(text);
  if (fixed.corrections.length) text = fixed.text;
  // Mesmos backstops do webhook do Messenger (o histórico é só o comentário).
  if (repairVisitOfferLeak(history, text)) text = repairDeclineMessage(lang);
  if (unsupportedFloorLeak(history, text)) text = unsupportedFloorReply(history, lang);
  if (mobileHomeLeak(history, text)) text = mobileHomeDeclineMessage(lang);
  if (portStLucieLeak(history, text)) text = portStLucieHandoffMessage(lang, portStLucieAskPhone(history));
  if (smallJobLeak(history, text)) text = smallJobReply(history, lang);
  if (bathroomLeak(history, text)) text = bathroomReply(history, lang);
  const psl = portStLucieStanding(history);
  const notify = /\[NOTIFY_OWNER\]/i.test(text) || promisesOwnerContact(text);
  text = text.replace(/\[NOTIFY_OWNER\]/gi, "").trim();
  text = stripForbiddenTags(psl ? text : redirectOwnerPromiseToPhone(text, lang)).trim();
  return text ? { text, notify, alert: psl ? PORT_ST_LUCIE_ALERT : null } : null;
}

// Exportada para o eval ao vivo (post-comment-verify): só lê (agenda, memória,
// correções) e chama o modelo, nunca envia.
export async function composePostCommentReply(cls: CommentClass, c: PostComment): Promise<Composed | null> {
  return composeReply(cls, c, commentStoredText(c));
}

async function composeReply(cls: CommentClass, c: PostComment, stored: string): Promise<Composed | null> {
  const lang = detectLang(c.message);
  if (cls === "critique") {
    const name = firstNameOf(c.fromName);
    const text = (await composeCommentCritiqueReply(c.message, name, lang)) ?? critiqueFallbackReply(lang, name);
    return { text, notify: false, alert: null };
  }
  return composeLeadReply(c, stored, lang);
}

// ─── Gravação da conversa ───────────────────────────────────────────────────
// O PSID devolvido pela Meta é a chave do Messenger: quando a pessoa responder,
// o webhook acha fb_<PSID> com o comentário + a nossa resposta no histórico.
// Grava logo depois do envio: o eco da resposta (is_echo) procura a conversa e
// a mensagem do bot, com 3 s de folga, antes de ler como resposta do dono.
async function persistThread(psid: string, c: PostComment, stored: string, reply: string) {
  const igsid = `fb_${psid}`;
  const cols = "id, igsid, name, username, created_at, mode";
  let { data: conv } = await supabaseAdmin.from("instagram_conversations").select(cols).eq("igsid", igsid).maybeSingle();
  if (!conv) {
    const { data: created, error } = await supabaseAdmin
      .from("instagram_conversations")
      .insert({ igsid, mode: "agent", ...(c.fromName ? { username: c.fromName } : {}) })
      .select(cols)
      .single();
    if (error) {
      const { data: existing } = await supabaseAdmin.from("instagram_conversations").select(cols).eq("igsid", igsid).maybeSingle();
      conv = existing ?? null;
    } else {
      conv = created;
    }
  }
  if (!conv) return null;
  const { data: userRow } = await supabaseAdmin
    .from("instagram_messages")
    .insert({ conversation_id: conv.id, role: "user", content: stored, instagram_msg_id: `fbcmt_${c.id}` })
    .select("id, created_at")
    .single();
  await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: reply });
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (!conv.username) {
    const profile = await withTimeout(fetchFacebookProfile(psid), 4000);
    if (profile?.name) update.username = profile.name;
    if (profile?.profile_pic) update.profile_pic = profile.profile_pic;
  }
  await supabaseAdmin.from("instagram_conversations").update(update).eq("id", conv.id);
  return { conv: { ...conv, username: (update.username as string | undefined) ?? conv.username }, userAt: userRow?.created_at ?? new Date().toISOString() };
}

// ─── Um comentário ──────────────────────────────────────────────────────────
export async function handlePostComment(input: PostComment, via: "sweep" | "webhook"): Promise<string> {
  let c = input;
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
  const now = Date.now();
  const el = commentEligibility(c, pageId, now);
  if (!el.ok) return el.reason;
  if (await facebookPaused()) return "paused";
  if (!(await claimComment(c.id))) return "already-claimed";
  let sentOk = false;
  try {
    if (via === "webhook" && c.postText == null) {
      const info = await postInfo(c.postId);
      c = { ...c, postText: info.text, source: info.isAd ? "ad" : "post" };
    }
    // Quem comentou já conversa com a gente e o comentário está na thread:
    // dono conduzindo, visita marcada ou já respondido → a resposta privada
    // cairia por cima (caso David, 03/10). Falha na busca = não responde agora.
    let thread: Awaited<ReturnType<typeof findThreadWithComment>>;
    try {
      thread = await findThreadWithComment(c);
    } catch (err) {
      console.warn("[COMMENTS] thread lookup failed, comment released:", String(err).slice(0, 150));
      await releaseComment(c.id);
      return "lookup-failed";
    }
    if (thread) {
      const why = commentThreadBlockReason(thread.conv, thread.rows, Date.parse(c.createdTime), now);
      if (why) {
        await recordOutcome(c.id, `thread-${why}`);
        console.log(`[COMMENTS] comment ${c.id} already lives in ${thread.conv.igsid} (${why}) — no private reply`);
        return `thread-${why}`;
      }
    }
    let cls: CommentClass;
    try {
      cls = await classifyPostComment(c.message, c.postText);
    } catch (err) {
      // API fora: devolve para a próxima varredura, nunca "skip" às cegas.
      console.warn("[COMMENTS] classifier failed, comment released:", String(err).slice(0, 150));
      await releaseComment(c.id);
      return "classify-failed";
    }
    if (!shouldReplyToClass(cls, c, now)) {
      await recordOutcome(c.id, `${cls}-no-reply`);
      return `${cls}-no-reply`;
    }
    const stored = commentStoredText(c);
    const composed = await composeReply(cls, c, stored);
    if (!composed) {
      await recordOutcome(c.id, `${cls}-empty`);
      return `${cls}-empty`;
    }
    // O dono pode ter pausado o Facebook enquanto a resposta era gerada.
    if (await facebookPaused()) {
      await releaseComment(c.id);
      return "paused";
    }
    const sent = await sendFacebookPrivateReply(c.id, composed.text);
    if (!sent.ok) {
      await recordOutcome(c.id, `send-failed|${sent.code ?? "x"}`);
      const failures = await priorSendFailures(c.id);
      const where = c.source === "ad" ? "anuncio" : "post";
      // Permissão/token: problema do CANAL. O comentário volta para a fila, a
      // varredura recua 1h (nada de gerar resposta que não sai a cada 3 min) e
      // o dono recebe UM aviso a cada 6h, não um por comentário. Um mesmo
      // comentário que falha 3x é largado (código 200 também pode ser só uma
      // pessoa que recusa mensagem de página).
      if (sent.code !== undefined && CHANNEL_BLOCK_CODES.has(sent.code) && failures < MAX_SEND_FAILURES) {
        await releaseComment(c.id);
        await supabaseAdmin.from("platform_settings").insert({ platform: `${BLOCKED_PREFIX}${new Date().toISOString()}`, paused: false });
        if (await shouldAlert("fbcmt-alert", "blocked", 6 * 3600_000)) {
          await notifyOwners({
            platform: `Facebook (comentario no ${where})`,
            clientName: c.fromName ?? null,
            clientId: `comentario ${c.id}`,
            recentMessages: [{ role: "user", content: c.message }],
            alert: `A resposta privada a comentarios do Facebook FALHOU (${(sent.error ?? "erro").slice(0, 100)}). Os comentarios ficam na fila e o bot tenta de novo em 1h. Se repetir, o token da pagina precisa da permissao de mensagens.`,
          }).catch((e) => console.error("[COMMENTS] owner alert failed:", e));
        }
        return "send-blocked";
      }
      const giveUp = !sent.retryable || failures >= MAX_SEND_FAILURES;
      if (!giveUp) await releaseComment(c.id);
      // Lead que o bot não conseguiu responder: o dono responde pelo inbox
      // (o chat do comentário fica lá por 7 dias). Um aviso a cada 6h.
      if (cls === "lead" && giveUp && (await shouldAlert("fbcmt-alert", "lead", 6 * 3600_000))) {
        await notifyOwners({
          platform: `Facebook (comentario no ${where})`,
          clientName: c.fromName ?? null,
          clientId: `comentario ${c.id}`,
          recentMessages: [{ role: "user", content: c.message }],
          alert: `Possivel cliente comentou no ${where} e o bot NAO conseguiu responder em privado (${(sent.error ?? "erro").slice(0, 80)}). Responda pelo inbox da pagina: o chat do comentario fica la por 7 dias.`,
        }).catch((e) => console.error("[COMMENTS] owner alert failed:", e));
      }
      return "send-failed";
    }
    sentOk = true;
    await recordOutcome(c.id, `replied-${cls}`);
    console.log(`[COMMENTS] ${via}: private reply sent to comment ${c.id} (${cls}) psid=${sent.recipientId ?? "?"}`);
    if (!sent.recipientId) {
      await recordOutcome(c.id, "no-psid");
      return `replied-${cls}`;
    }
    const saved = await persistThread(sent.recipientId, c, stored, composed.text);
    if (saved && composed.notify) {
      await notifyOwners({
        platform: "Messenger (comentario)",
        clientName: saved.conv.username ?? c.fromName ?? null,
        clientId: sent.recipientId,
        recentMessages: [
          { role: "user", content: stored },
          { role: "assistant", content: composed.text },
        ],
        alert: composed.alert,
      }).catch((e) => console.error("[COMMENTS] notify failed:", e));
    }
    // Funil (lead_criado): o comentário é a 1ª mensagem da conversa; sem isto o
    // lead nunca nasceria na plataforma (a resposta dele no Messenger já não é
    // a 1ª). Crítica não é lead.
    if (saved && cls === "lead") {
      await funilOnInboundMessage(
        { id: saved.conv.id, igsid: saved.conv.igsid, name: saved.conv.name, username: saved.conv.username, created_at: saved.conv.created_at },
        c.message,
        saved.userAt
      ).catch((e) => console.error("[COMMENTS] funil failed:", e));
    }
    return `replied-${cls}`;
  } catch (err) {
    // Antes do envio: devolve a trava (a próxima varredura tenta de novo).
    // Depois do envio: a trava fica — responder 2x é pior que gravar torto.
    console.error("[COMMENTS] handle failed:", err);
    if (!sentOk) await releaseComment(c.id);
    return "error";
  }
}

// ─── Entradas ───────────────────────────────────────────────────────────────
// Webhook `feed`: chamado pelo POST do /api/fb-webhook via waitUntil.
export async function handleFeedWebhookComments(body: unknown): Promise<void> {
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
  for (const c of commentsFromWebhookBody(body, pageId)) {
    try {
      const out = await handlePostComment(c, "webhook");
      console.log(`[COMMENTS] webhook comment ${c.id} → ${out}`);
    } catch (err) {
      console.error("[COMMENTS] webhook comment failed:", err);
    }
  }
}

// Prévia SÓ LEITURA da varredura (diagnóstico / verificação antes do deploy):
// mesmos posts, comentários, elegibilidade e travas; classifica se pedido.
// Nunca trava, nunca envia, nunca grava.
export async function previewPostComments(opts?: { classify?: boolean }): Promise<{
  reader: "ads" | "page" | null;
  posts: number;
  comments: number;
  pending: Array<{ id: string; createdTime: string; source: CommentSource; message: string; cls?: CommentClass; wouldReply?: boolean; thread?: string }>;
}> {
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
  const reader = pageId ? await commentReader(pageId) : null;
  if (!reader) return { reader: null, posts: 0, comments: 0, pending: [] };
  const now = Date.now();
  const posts = await listActivePosts(reader, pageId, now);
  const comments = await fetchTopLevelComments(reader.token, posts);
  const eligible = comments.filter((c) => commentEligibility(c, pageId, now).ok);
  const claimed = (await claimedCommentIds(eligible.map((c) => c.id))) ?? new Set<string>();
  const pending = eligible.filter((c) => !claimed.has(c.id)).sort((a, b) => b.createdTime.localeCompare(a.createdTime));
  const out = [];
  for (const c of pending) {
    const row: { id: string; createdTime: string; source: CommentSource; message: string; cls?: CommentClass; wouldReply?: boolean; thread?: string } = {
      id: c.id, createdTime: c.createdTime, source: c.source, message: c.message,
    };
    if (opts?.classify) {
      row.cls = await classifyPostComment(c.message, c.postText).catch(() => undefined);
      row.wouldReply = row.cls ? shouldReplyToClass(row.cls, c, now) : undefined;
      if (row.wouldReply) {
        const thread = await findThreadWithComment(c).catch(() => null);
        const why = thread ? commentThreadBlockReason(thread.conv, thread.rows, Date.parse(c.createdTime), now) : null;
        if (why) { row.wouldReply = false; row.thread = `${thread?.conv.igsid} (${why})`; }
        else if (thread) row.thread = `${thread.conv.igsid} (responde na thread)`;
      }
    }
    out.push(row);
  }
  return { reader: reader.ads ? "ads" : "page", posts: posts.length, comments: comments.length, pending: out };
}

// Varredura: chamada no tráfego dos 3 webhooks (como recoverLostInbounds),
// autolimitada a 1 a cada 3 min.
export async function sweepPostComments(): Promise<void> {
  try {
    const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
    if (!pageId) return;
    if (!(await shouldAlert("fbcomments", "sweep", COMMENT_SWEEP_GAP_MS))) return;
    if (await facebookPaused()) return;
    if (await channelBlockedRecently()) return;
    const reader = await commentReader(pageId);
    if (!reader) return;
    const now = Date.now();
    const posts = await listActivePosts(reader, pageId, now);
    if (!posts.length) return;
    const comments = await fetchTopLevelComments(reader.token, posts);
    const eligible = comments.filter((c) => commentEligibility(c, pageId, now).ok);
    if (!eligible.length) return;
    const claimed = await claimedCommentIds(eligible.map((c) => c.id));
    if (!claimed) return;
    const todo = eligible
      .filter((c) => !claimed.has(c.id))
      .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
      .slice(0, COMMENT_MAX_CLASSIFIED_PER_SWEEP);
    // O teto conta respostas (geração + envio); "skip" custa só a classificação.
    let replies = 0;
    for (const c of todo) {
      const out = await handlePostComment(c, "sweep");
      console.log(`[COMMENTS] sweep comment ${c.id} → ${out}`);
      if (out === "send-blocked") break;
      if (out.startsWith("replied-") || out === "send-failed" || out === "error") replies++;
      if (replies >= COMMENT_MAX_PER_SWEEP) break;
    }
  } catch (err) {
    console.error("[COMMENTS] sweep failed:", err);
  }
}
