// ─── Reel/post forwarded from someone else's feed, with no words (14/10/2026) ──
// Meta delivers a forwarded reel/post/link as an attachment with NO text and,
// on Instagram, NO referral: ig_reel {reel_video_id, title, url}, ig_post
// {ig_post_media_id, title, url}; on Messenger reel/post/fallback {title, url}.
// That is exactly the shape the webhooks turned into "[Client replied to our
// ad]", so every forwarded meme, prayer or political clip got the "tile, vinyl,
// or hardwood?" nudge: 365 reels + 125 posts in one week on IG, 106 threads in
// 30 days where the client never typed a word (NA CY GOGARTY: 62 reels, 62 bot
// replies; Stephen Bell: 17 reels, 13 replies). Owner's rule (14/10): do not
// answer those people.
//
// What still counts as an ad reply: OUR ad post/reel forwarded with no words
// (62 of 63 such people typed real text afterwards). Ours is decided by the ad
// caption signature or by the platform's media→ad map (the same lookup the
// funnel uses). Third-party FLOORING content goes to the model as a note.
// Everything else is dropped before it is stored: no message row, no funnel
// lead, no reply. The ad card ("template", 8 of 17 booked), stories,
// disappearing photos, images, audio and video are NOT feed shares and keep
// their existing paths.

export type FeedShare = { type: string; title: string; url: string; mediaIds: string[] };
export type MediaLookup = { ok: boolean; ours: boolean };
export type FeedShareVerdict =
  | { kind: "none" }
  | { kind: "ours"; share: FeedShare; via: "caption" | "platform" | "unverifiable-ad-click" }
  | { kind: "flooring"; share: FeedShare; note: string }
  | { kind: "unrelated"; share: FeedShare };

// Attachment types Meta uses for content forwarded from a feed (IG: ig_reel,
// ig_post, share; Messenger: reel, post, fallback = external link card).
const FEED_SHARE_TYPES = new Set(["ig_reel", "ig_post", "share", "reel", "post", "fallback"]);

export function feedShareOf(message: unknown): FeedShare | null {
  const msg = (message ?? {}) as { attachments?: Array<{ type?: string; payload?: Record<string, unknown> }> };
  const att = (msg.attachments ?? []).find((a) => FEED_SHARE_TYPES.has(String(a?.type ?? "")));
  if (!att) return null;
  const p = att.payload ?? {};
  const title = typeof p.title === "string" ? p.title.replace(/\s+/g, " ").trim() : "";
  const url = typeof p.url === "string" ? p.url : "";
  const ids = new Set<string>();
  for (const k of ["reel_video_id", "ig_post_media_id", "media_id"]) {
    const v = p[k];
    if (typeof v === "string" && /^\d{8,}$/.test(v)) ids.add(v);
  }
  const m = /asset_id=(\d{8,})/.exec(url) ?? /facebook\.com\/reel\/(\d{8,})/.exec(url);
  if (m) ids.add(m[1]);
  return { type: String(att.type), title, url, mediaIds: [...ids] };
}

// Our ad captions, verbatim from the forwarded posts: "✨ 1000 sq.ft. FOR JUST
// $2,350 ❌ materials ✨ 1000 sq.ft. ONLY $5,100 ✅ with materials ..." and the
// Messenger card "Ozzi floors added a new photo." Deliberately narrow: a bare
// "only $9.99" is any shop's reel; the sq.ft. price line and the ❌/✅ materials
// marks are ours. Anything else goes through the platform's media→ad map.
export const OUR_AD_CAPTION_RE = /\bozzi\b|sq\.?\s?ft\.?\s*(?:for just|only)\s*\$\s?\d|❌\s*materia|✅\s*(?:with|con|com)\s*materia/i;
// Third-party content that is still about floors (a look the client likes).
// A bare "floor"/"piso" is NOT enough: "Senate floor", "casa de dos pisos" came
// through. \b is ASCII in JS, so the boundaries are accent-safe by hand.
export const FLOORING_CAPTION_RE = /(?<![a-zà-ÿ])(?:vinyl|vinilo|vin[ií]lico|tiles?|porcelain|porcelanato|hardwood|laminate|laminado|flooring|floors|herringbone|chevron|lvp|sq\.?\s?ft|backsplash|baseboards?|rodap[ée]s?)(?![a-zà-ÿ])/i;

// The note the model reads instead of the ad placeholder. It starts with
// "[Client shared a post" on purpose: ai.ts strips that family as non-client
// words (NON_CLIENT_TAGS) and the ad-placeholder regexes do NOT match it, so
// no ad note and no re-tap nudge are triggered by a third-party reel.
export const FLOORING_SHARE_NOTE_PREFIX = "[Client shared a post/reel about flooring";
export function flooringShareNote(share: FeedShare): string {
  const t = share.title.replace(/[\[\]"]/g, "").slice(0, 120).trim();
  return t ? `${FLOORING_SHARE_NOTE_PREFIX}: "${t}"]` : `${FLOORING_SHARE_NOTE_PREFIX}]`;
}
export function isFlooringShareNote(text: string): boolean {
  return (text ?? "").trim().startsWith(FLOORING_SHARE_NOTE_PREFIX);
}

// Pure verdict. `lookup` is the platform's answer for the share's media ids
// (null = nothing to ask / not asked).
export function judgeFeedShare(
  share: FeedShare | null,
  ctx: { hasText: boolean; hasPostback: boolean; hasReferral: boolean; lookup: MediaLookup | null }
): FeedShareVerdict {
  // The client typed something (or tapped an icebreaker): the words decide,
  // the attachment is only context. Unchanged flow.
  if (!share || ctx.hasText || ctx.hasPostback) return { kind: "none" };
  if (OUR_AD_CAPTION_RE.test(share.title)) return { kind: "ours", share, via: "caption" };
  if (ctx.lookup?.ours) return { kind: "ours", share, via: "platform" };
  // An ad click whose media we could not check (platform down, no token, no
  // media id) keeps the old benefit of the doubt. A referral the platform DID
  // answer "not ours" for is Messenger re-attaching the thread's original ad
  // referral to a forwarded meme: it proves nothing about this share.
  if (ctx.hasReferral && !ctx.lookup?.ok) return { kind: "ours", share, via: "unverifiable-ad-click" };
  if (FLOORING_CAPTION_RE.test(share.title)) return { kind: "flooring", share, note: flooringShareNote(share) };
  return { kind: "unrelated", share };
}

// Webhook entry point: reads the attachment, asks the platform only when the
// caption did not already settle it, never throws.
export async function classifyFeedShare(
  message: unknown,
  ctx: { hasText: boolean; hasPostback: boolean; hasReferral: boolean },
  consultar: (ids: string[]) => Promise<{ ok: boolean; resolvidas: Record<string, unknown> }>
): Promise<FeedShareVerdict> {
  const share = feedShareOf(message);
  if (!share || ctx.hasText || ctx.hasPostback) return { kind: "none" };
  if (OUR_AD_CAPTION_RE.test(share.title)) return judgeFeedShare(share, { ...ctx, lookup: null });
  let lookup: MediaLookup | null = null;
  if (share.mediaIds.length) {
    try {
      const r = await consultar(share.mediaIds);
      lookup = { ok: r.ok, ours: share.mediaIds.some((id) => !!r.resolvidas?.[id]) };
    } catch {
      lookup = { ok: false, ours: false };
    }
  }
  return judgeFeedShare(share, { ...ctx, lookup });
}
