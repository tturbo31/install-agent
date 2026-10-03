import { reportSendFailure } from "@/lib/delivery";
import { getAdsToken } from "@/lib/ads-token";
import { stripInternalMarkers } from "@/lib/outbound-text";
import { getFacebookPageToken } from "@/lib/fb-token";
import { pendingCommentChat, clearCommentChat } from "@/lib/post-comments";

const FB_API = "https://graph.facebook.com/v24.0";

// DB-first (see fb-token.ts): a dead page token can be swapped from the phone
// via /api/ig-diag?setfbtoken=..., with the env var as the fallback.
async function getToken(): Promise<string> {
  return getFacebookPageToken();
}

export type FbSendResult = { ok: boolean; error?: string };

// Send a text message via Facebook Messenger. VERIFIED (2026-07-22, same
// hardening as IG/WA): retry once on a transient failure, alert the owner on a
// definitive one, and return a result so callers stop recording undelivered
// replies as sent.
export async function sendFacebookMessage(psid: string, text: string): Promise<FbSendResult> {
  text = stripInternalMarkers(text);
  if (!text) return { ok: false, error: "empty text after marker strip" };
  // Chat que o Facebook criou a partir de um COMENTÁRIO (Joshua Gray, 03/10/2026):
  // a 1ª mensagem da página só entra como resposta privada ao comentário — o
  // envio normal volta (#551). O webhook gravou o vínculo PSID → comentário ao
  // receber o aviso do chat; usado (ou recusado de vez), ele some.
  const pending = await pendingCommentChat(psid).catch(() => null);
  if (pending) {
    const pr = await sendFacebookPrivateReply(pending.commentId, text);
    if (pr.ok || !pr.retryable) await clearCommentChat(pending.key);
    if (pr.ok) {
      if (pr.recipientId && pr.recipientId !== psid) console.warn(`[COMMENT-CHAT] private reply went to ${pr.recipientId}, chat is ${psid}`);
      console.log(`[COMMENT-CHAT] first reply in comment chat ${psid} sent as private reply to comment ${pending.commentId}`);
      return { ok: true };
    }
    console.warn(`[COMMENT-CHAT] private reply to ${pending.commentId} failed (${pr.error}) — trying the normal send`);
  }
  let lastErr = "not attempted";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${FB_API}/me/messages?access_token=${await getToken()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text },
          messaging_type: "RESPONSE",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message_id?: string;
        error?: { message?: string; code?: number };
      };
      if (!body.error && (body.message_id || res.ok)) return { ok: true };
      lastErr = `${body.error?.code ?? res.status}: ${body.error?.message ?? "unknown"}`;
      console.error(`🚨 sendFacebookMessage FAILED (attempt ${attempt}/2) psid=${psid} ${lastErr}`);
      if (body.error?.code === 190) break; // dead token won't heal on retry
    } catch (err) {
      lastErr = String(err).slice(0, 200);
      console.error(`🚨 sendFacebookMessage EXCEPTION (attempt ${attempt}/2):`, err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
  }
  await reportSendFailure("facebook", psid, lastErr);
  return { ok: false, error: lastErr };
}

export type FbPrivateReplyResult = { ok: boolean; recipientId?: string; messageId?: string; error?: string; code?: number; retryable?: boolean };

// RESPOSTA PRIVADA a um comentário (03/10/2026): a única mensagem que a Meta
// aceita como a 1ª da página no chat que ela criou a partir de um comentário.
// Entra no Messenger de quem comentou e devolve o PSID (recipient_id). UMA por
// comentário, até 7 dias. Sem reportSendFailure aqui: se falhar, o
// sendFacebookMessage tenta o envio normal, que tem o alerta de sempre.
export async function sendFacebookPrivateReply(commentId: string, text: string): Promise<FbPrivateReplyResult> {
  text = stripInternalMarkers(text);
  if (!text) return { ok: false, error: "empty text after marker strip" };
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
  if (!pageId) return { ok: false, error: "FACEBOOK_PAGE_ID missing" };
  let last: FbPrivateReplyResult = { ok: false, error: "not attempted", retryable: true };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${FB_API}/${pageId}/messages?access_token=${await getToken()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        recipient_id?: string;
        message_id?: string;
        error?: { message?: string; code?: number };
      };
      if (!body.error && res.ok) return { ok: true, recipientId: body.recipient_id, messageId: body.message_id };
      const code = body.error?.code;
      // 1/2/4/17/341 = instabilidade ou limite da Meta: vale tentar de novo.
      const retryable = code === undefined ? res.status >= 500 : [1, 2, 4, 17, 341].includes(code);
      last = { ok: false, code, retryable, error: `${code ?? res.status}: ${body.error?.message ?? "unknown"}` };
      console.error(`🚨 sendFacebookPrivateReply FAILED (attempt ${attempt}/2) comment=${commentId} ${last.error}`);
      if (!retryable) break;
    } catch (err) {
      last = { ok: false, retryable: true, error: String(err).slice(0, 200) };
      console.error(`🚨 sendFacebookPrivateReply EXCEPTION (attempt ${attempt}/2):`, err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
  }
  return last;
}

// Get Facebook user profile (name + profile pic)
export async function fetchFacebookProfile(psid: string): Promise<{ name?: string; profile_pic?: string }> {
  try {
    const res = await fetch(
      `${FB_API}/${psid}?fields=name,profile_pic&access_token=${await getToken()}`
    );
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// Best-effort: "see the ad" by pulling its creative (all text fields + the main
// image) from the Meta Graph API using the ad_id that Meta sends on the referral.
// This is how we identify the flooring type (tile vs vinyl vs hardwood) even when
// the referral delivered no ad_title/photo_url. Requires the token to have
// ads_read on the ad account; returns nulls on ANY error (permissions, not found,
// network) so callers degrade safely to asking the client. Set META_ADS_TOKEN to
// use a dedicated ads token; otherwise the page token is tried.
export async function fetchAdCreative(adId: string): Promise<{ text: string | null; imageUrl: string | null }> {
  const empty = { text: null as string | null, imageUrl: null as string | null };
  try {
    if (!adId || !/^\d{3,}$/.test(adId)) return empty;
    const token = (await getAdsToken()) || (await getToken());
    const fields = "name,creative{name,title,body,image_url,thumbnail_url,link_url,object_story_spec,asset_feed_spec}";
    const res = await fetch(`${FB_API}/${adId}?fields=${encodeURIComponent(fields)}&access_token=${token}`);
    if (!res.ok) return empty;
    const data = await res.json().catch(() => null);
    if (!data || data.error) return empty;
    const c = (data.creative ?? {}) as Record<string, any>;
    const oss = (c.object_story_spec ?? {}) as Record<string, any>;
    const link = (oss.link_data ?? oss.video_data ?? oss.template_data ?? {}) as Record<string, any>;
    const afs = (c.asset_feed_spec ?? {}) as Record<string, any>;
    const texts: Array<string | undefined> = [
      data.name, c.name, c.title, c.body, c.link_url,
      link.message, link.name, link.caption, link.description, link.link,
      ...(Array.isArray(afs.titles) ? afs.titles.map((t: any) => t?.text) : []),
      ...(Array.isArray(afs.bodies) ? afs.bodies.map((b: any) => b?.text) : []),
      ...(Array.isArray(afs.link_urls) ? afs.link_urls.map((l: any) => l?.website_url) : []),
    ];
    const text = texts.filter(Boolean).join(" | ") || null;
    const imageUrl =
      c.image_url || c.thumbnail_url || link.picture ||
      (Array.isArray(afs.images) && afs.images[0]?.url) || null;
    return { text, imageUrl: imageUrl || null };
  } catch {
    return empty;
  }
}

// Download image from URL (for floor plans sent via Messenger)
export async function downloadFacebookAttachment(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 2000) return null;
    return `data:${ct.split(";")[0]};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}
