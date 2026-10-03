// ─── Chat criado por comentário: vínculo chat (PSID) → comentário ────────────
// Caso e regras em post-comment-policy.ts (Joshua Gray, 03/10/2026). Quando o
// aviso "Facebook created this chat because X commented on your post" chega ao
// webhook do Messenger, o id do comentário vai para platform_settings como
//   fbcmtchat|<psid>|<comment_id>|<isoAgora>
// e o sendFacebookMessage manda a PRÓXIMA mensagem para esse PSID como resposta
// privada ao comentário (a única que a Meta aceita nesse chat). Usado uma vez,
// o vínculo some. Nada aqui procura comentário por conta própria.
import { supabaseAdmin } from "@/lib/supabase";
import { getFacebookPageToken } from "@/lib/fb-token";
import { getAdsToken } from "@/lib/ads-token";
import { COMMENT_CHAT_TTL_MS, commentIdFromNotice } from "@/lib/post-comment-policy";

const GRAPH = "https://graph.facebook.com/v24.0";
const PREFIX = "fbcmtchat|";

// ─── Token de LEITURA dos comentários ───────────────────────────────────────
// O link do aviso traz só a parte local do id (comment_id=1606996650894324); o
// id da Graph é "<objeto>_<local>" e o objeto é o post do ANÚNCIO, que só se lê
// com pages_manage_ads — o page token do Messenger não tem. O token de anúncios
// (adstok|…, conferido em 03/10) devolve via /me/accounts o page token derivado
// que lê os ads_posts. Sem ele, só o feed orgânico.
async function commentReaderToken(pageId: string): Promise<{ token: string; ads: boolean } | null> {
  try {
    const adsTok = await getAdsToken();
    if (adsTok) {
      const r = await fetch(`${GRAPH}/me/accounts?fields=id,access_token&limit=100&access_token=${encodeURIComponent(adsTok)}`);
      const b = (await r.json().catch(() => ({}))) as { data?: Array<{ id?: string; access_token?: string }> };
      const tok = b.data?.find((a) => a.id === pageId)?.access_token;
      if (tok) return { token: tok, ads: true };
    }
  } catch (err) {
    console.warn("[COMMENT-CHAT] ads-derived page token unavailable:", String(err).slice(0, 150));
  }
  const pageTok = await getFacebookPageToken();
  return pageTok ? { token: pageTok, ads: false } : null;
}

type Page<T> = { data?: T[]; paging?: { next?: string }; error?: unknown };

async function graphGet<T>(pathOrUrl: string, token: string): Promise<T | null> {
  try {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${GRAPH}/${pathOrUrl}${pathOrUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
    const body = (await (await fetch(url)).json().catch(() => null)) as (T & { error?: unknown }) | null;
    return body && !body.error ? body : null;
  } catch {
    return null;
  }
}

// Acha o id completo ("<objeto>_<local>") entre os comentários dos posts com
// atividade nos últimos 7 dias (updated_time sobe a cada comentário novo).
async function findCommentByLocalId(localId: string): Promise<string | null> {
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
  const reader = pageId ? await commentReaderToken(pageId) : null;
  if (!reader) return null;
  const since = Date.now() - COMMENT_CHAT_TTL_MS;
  const posts: string[] = [];
  const take = (rows: Array<{ id?: string; updated_time?: string }> | undefined) => {
    for (const p of rows ?? []) if (p.id && p.updated_time && Date.parse(p.updated_time) >= since && !posts.includes(p.id)) posts.push(p.id);
  };
  if (reader.ads) {
    let next: string | null = `${pageId}/ads_posts?fields=id,updated_time&limit=100&include_inline_create=true`;
    for (let i = 0; i < 8 && next; i++) {
      const page: Page<{ id?: string; updated_time?: string }> | null = await graphGet(next, reader.token);
      if (!page) break;
      take(page.data);
      next = page.paging?.next ?? null;
    }
  }
  take((await graphGet<Page<{ id?: string; updated_time?: string }>>(`${pageId}/feed?fields=id,updated_time&limit=50`, reader.token))?.data);
  const fields = encodeURIComponent("comments.filter(stream).order(reverse_chronological).limit(100){id}");
  for (let i = 0; i < posts.length; i += 50) {
    const ids = posts.slice(i, i + 50).join(",");
    const b = await graphGet<Record<string, { comments?: { data?: Array<{ id?: string }> } }>>(`?ids=${ids}&fields=${fields}`, reader.token);
    for (const v of Object.values(b ?? {})) {
      const hit = v.comments?.data?.find((c) => c.id?.endsWith(`_${localId}`));
      if (hit?.id) return hit.id;
    }
  }
  return null;
}

// Aviso do chat → id completo do comentário (ou null).
export async function resolveCommentChatCommentId(notice: string): Promise<string | null> {
  const { localId, fullId } = commentIdFromNotice(notice);
  if (fullId) return fullId;
  if (!localId) return null;
  return findCommentByLocalId(localId);
}

// Grava o vínculo PSID → comentário (idempotente: o mesmo par não duplica).
export async function registerCommentChat(psid: string, commentId: string): Promise<void> {
  const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `${PREFIX}${psid}|${commentId}|%`).limit(1);
  if (data?.length) return;
  const { error } = await supabaseAdmin.from("platform_settings").insert({ platform: `${PREFIX}${psid}|${commentId}|${new Date().toISOString()}`, paused: false });
  if (error) console.error("[COMMENT-CHAT] register failed:", error.message);
}

// Vínculo vivo para este PSID (o mais recente), apagando os vencidos.
export async function pendingCommentChat(psid: string): Promise<{ key: string; commentId: string } | null> {
  const { data, error } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `${PREFIX}${psid}|%`);
  if (error || !data?.length) return null;
  let best: { key: string; commentId: string; at: number } | null = null;
  for (const r of data) {
    const key = String(r.platform);
    const [, , commentId, iso] = key.split("|");
    const at = Date.parse(iso ?? "");
    if (!commentId || !Number.isFinite(at) || Date.now() - at > COMMENT_CHAT_TTL_MS) {
      await supabaseAdmin.from("platform_settings").delete().eq("platform", key);
      continue;
    }
    if (!best || at > best.at) best = { key, commentId, at };
  }
  return best ? { key: best.key, commentId: best.commentId } : null;
}

export async function clearCommentChat(key: string): Promise<void> {
  const { error } = await supabaseAdmin.from("platform_settings").delete().eq("platform", key);
  if (error) console.error("[COMMENT-CHAT] clear failed:", error.message);
}
